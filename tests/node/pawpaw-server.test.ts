// The PawpawBI server client (src/pawpaw-server.ts) against the stand-in server
// (scripts/pawpaw-server-stub.mjs), and the published records (src/published-files.ts).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startStubServer } from '../../scripts/pawpaw-server-stub.mjs';
import { zipFolder } from '../../src/pawpaw-archive.ts';
import {
  isReportUrl,
  pawpawServer,
  SignedOutError,
} from '../../src/pawpaw-server.ts';
import {
  cleanList,
  cleanPublished,
  publishedFile,
  withEntry,
} from '../../src/published-files.ts';

let stub: { url: string; origin: string; close: () => Promise<void> };
let dir: string;

before(async () => {
  stub = await startStubServer(0);
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pawpaw-server-'));
});

after(async () => {
  await stub.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function siteZip(files: Record<string, string>) {
  const site = await fs.mkdtemp(path.join(dir, 'site-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(site, name)), { recursive: true });
    await fs.writeFile(path.join(site, name), content);
  }
  return zipFolder(site);
}

test('signing up, signing in and out', async () => {
  const server = pawpawServer(stub.url);
  const { token, account } = await server.signUp(
    'ana@example.com',
    'long enough',
  );
  assert.equal(account.email, 'ana@example.com');
  await assert.rejects(
    server.signUp('ana@example.com', 'long enough'),
    /already/,
  );
  await assert.rejects(
    server.signUp('bo@example.com', 'short'),
    /8 characters/,
  );
  await assert.rejects(
    server.signIn('ana@example.com', 'wrong password'),
    SignedOutError,
  );
  const again = await server.signIn('ana@example.com', 'long enough');
  assert.equal(
    (await pawpawServer(stub.url, again.token).account()).email,
    'ana@example.com',
  );

  await pawpawServer(stub.url, token).signOut();
  await assert.rejects(pawpawServer(stub.url, token).account(), SignedOutError);
});

test('signing in with Google: the code from the browser is swapped for a token', async () => {
  const server = pawpawServer(stub.url);
  const redirect = 'http://127.0.0.1:5555/callback';
  const start = server.providerStartUrl('google', redirect, 'xyz');
  const page = await (await fetch(start)).text();
  const link = /href="([^"]+)"/.exec(page)![1].replace(/&#38;/g, '&');
  const back = new URL(link);
  assert.equal(back.origin + back.pathname, redirect);
  assert.equal(back.searchParams.get('state'), 'xyz');
  const { account } = await server.providerToken(
    'google',
    back.searchParams.get('code')!,
    redirect,
  );
  assert.match(account.email, /@google\.example$/);
  // A code works once.
  await assert.rejects(
    server.providerToken('google', back.searchParams.get('code')!, redirect),
    /expired/,
  );
});

test('publishing a site, then refreshing only its data', async () => {
  const { token } = await pawpawServer(stub.url).signUp(
    'cy@example.com',
    'password1',
  );
  const server = pawpawServer(stub.url, token);
  const created = await server.createReport('Sales');
  assert.ok(isReportUrl(created.url));
  assert.equal(created.publishedAt, null);

  const published = await server.uploadSite(
    created.id,
    await siteZip({
      'index.html': '<h1>Sales</h1>',
      'data/sales.json': '{"rows":[[1]]}',
    }),
  );
  assert.ok(published.publishedAt);
  assert.equal(await (await fetch(published.url)).text(), '<h1>Sales</h1>');

  await server.uploadData(
    created.id,
    await siteZip({ 'data/sales.json': '{"rows":[[2]]}' }),
  );
  assert.equal(
    await (await fetch(new URL('data/sales.json', published.url))).text(),
    '{"rows":[[2]]}',
  );
  await assert.rejects(
    server.uploadData(created.id, await siteZip({ 'index.html': 'x' })),
    /Only data files/,
  );
  assert.deepEqual(
    (await server.listReports()).map((r) => r.id),
    [created.id],
  );

  // Someone else's account can't touch it.
  const other = await pawpawServer(stub.url).signUp(
    'di@example.com',
    'password2',
  );
  await assert.rejects(
    pawpawServer(stub.url, other.token).uploadSite(
      created.id,
      await siteZip({ 'a.html': '' }),
    ),
    /no report with that ID/,
  );
  await assert.rejects(
    server.uploadSite('../x', Buffer.alloc(0)),
    /Invalid report ID/,
  );
});

test("a server that can't be reached says so", async () => {
  await assert.rejects(
    pawpawServer('http://127.0.0.1:9/v1').signIn('a@b.c', 'x'),
    /Couldn’t reach PawpawBI/,
  );
});

test('published records from project files are checked', () => {
  const report = {
    reportId: 'abc_123',
    url: 'https://reports.example.com/abc/',
    account: 'ana@example.com',
    publishedAt: '2026-10-18T10:00:00.000Z',
    refreshedAt: null,
  };
  assert.deepEqual(cleanPublished(publishedFile(report)), report);
  assert.equal(
    cleanPublished({ pawpawbi: { ...report, reportId: '../x' } }),
    null,
  );
  assert.equal(
    cleanPublished({ pawpawbi: { ...report, url: 'javascript:alert(1)' } }),
    null,
  );
  assert.equal(
    cleanPublished({ pawpawbi: { ...report, url: 'http://evil.example/' } }),
    null,
  );
  assert.equal(cleanPublished(null), null);

  const entry = {
    ...report,
    projectId: 'p1',
    projectName: 'Sales',
    projectPath: 'C:\\Reports\\Sales.pawpaw',
  };
  assert.deepEqual(
    cleanList({ projects: [entry, { ...entry, projectId: '../x' }, 'junk'] }),
    [entry],
  );

  // The same report seen at a new path replaces its old entry.
  const moved = { ...entry, projectPath: 'D:\\Sales.pawpaw' };
  const other = { ...entry, reportId: 'zzz', projectName: 'Atlas' };
  assert.deepEqual(withEntry(withEntry([entry], other), moved), [other, moved]);
});
