// The PawpawBI server client (src/pawpaw-server.ts) against the stand-in server, which also
// stands in for S3 (scripts/pawpaw-server-stub.mjs), and the published records
// (src/published-files.ts).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { startStubServer } from '../../scripts/pawpaw-server-stub.mjs';
import {
  isReportUrl,
  MissingFilesError,
  packFile,
  pawpawServer,
  SignedOutError,
  uploadFiles,
  type PawpawServer,
} from '../../src/pawpaw-server.ts';
import {
  cleanList,
  cleanPublished,
  publishedFile,
  withEntry,
} from '../../src/published-files.ts';

let stub: { url: string; origin: string; close: () => Promise<void> };

before(async () => {
  stub = await startStubServer(0);
});

after(() => stub.close());

const pack = (files: Record<string, string>) =>
  Object.entries(files).map(([path, text]) =>
    packFile(
      path,
      Buffer.from(text),
      path.endsWith('.json') ? 'application/json' : 'text/html',
    ),
  );

/** Starts a version, PUTs every file to its presigned URL and completes it, as the app does. */
async function upload(
  server: PawpawServer,
  packed: ReturnType<typeof pack>,
  start: (
    files: ReturnType<typeof pack>[number]['file'][],
  ) => ReturnType<PawpawServer['createReport']>,
) {
  const { report, version, uploads } = await start(packed.map((p) => p.file));
  for (const u of uploads) {
    await server.putFile(u, packed.find((p) => p.file.path === u.path)!.body);
  }
  return server.completeUpload(report.id, version);
}

const fetchText = async (url: string | URL) => {
  const response = await fetch(url);
  return response.ok ? response.text() : `${response.status}`;
};

test('files are gzipped, with the size and checksum of what is sent', () => {
  const { file, body } = packFile(
    'index.html',
    Buffer.from('<h1>Hi</h1>'),
    'text/html',
  );
  assert.equal(gunzipSync(body).toString(), '<h1>Hi</h1>');
  assert.equal(file.size, body.length);
  assert.match(file.sha256, /^[A-Za-z0-9+/]{43}=$/);
});

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

test('publishing uploads each file to S3, then upload_complete makes the version current', async () => {
  const { token } = await pawpawServer(stub.url).signUp(
    'cy@example.com',
    'password1',
  );
  const server = pawpawServer(stub.url, token);
  const site = pack({
    'index.html': '<h1>Sales</h1>',
    'data/sales.json': '{"rows":[[1]]}',
  });

  const { report, version, uploads } = await server.createReport(
    'Sales',
    site.map((p) => p.file),
  );
  assert.ok(isReportUrl(report.url));
  assert.equal(report.publishedAt, null);
  // Each file is stored under its own name with the version in it.
  const objectName = (url: string) =>
    decodeURIComponent(new URL(url).pathname).split('/').slice(-2).join('/');
  assert.deepEqual(
    uploads.map((u) => objectName(u.url)),
    [`${report.id}/index.${version}.html`, `data/sales.${version}.json`],
  );
  await server.putFile(uploads[0], site[0].body);

  // A file is missing: the server says which, and nothing changes.
  const incomplete = await server
    .completeUpload(report.id, version)
    .catch((e) => e);
  assert.ok(incomplete instanceof MissingFilesError);
  assert.deepEqual(incomplete.missing, ['data/sales.json']);
  await assert.rejects(server.getReport(report.id), /no published report/);

  await server.putFile(uploads[1], site[1].body);
  const completed = await server.completeUpload(report.id, version);
  assert.ok(completed.publishedAt);

  const current = await server.getReport(report.id);
  assert.deepEqual(current.files.map((f) => f.path).sort(), [
    'data/sales.json',
    'index.html',
  ]);
  assert.ok(
    current.files.every((f) =>
      decodeURIComponent(f.url).includes(`.${version}.`),
    ),
    'download URLs point at the versioned objects',
  );
  // Browsers get the files unzipped (Content-Encoding: gzip), from S3 or the viewer address.
  const index = current.files.find((f) => f.path === 'index.html')!;
  assert.equal(await fetchText(index.url), '<h1>Sales</h1>');
  assert.equal(await fetchText(report.url), '<h1>Sales</h1>');

  // While a new version uploads, viewers keep the current one.
  const pending = pack({ 'data/sales.json': '{"rows":[[9]]}' });
  const next = await server.updateReport(
    report.id,
    'data',
    pending.map((p) => p.file),
  );
  await server.putFile(next.uploads[0], pending[0].body);
  assert.equal(
    await fetchText(new URL('data/sales.json', report.url)),
    '{"rows":[[1]]}',
  );

  // A data refresh replaces only the data, and keeps the rest of the site.
  await upload(server, pack({ 'data/sales.json': '{"rows":[[2]]}' }), (files) =>
    server.updateReport(report.id, 'data', files),
  );
  assert.equal(
    await fetchText(new URL('data/sales.json', report.url)),
    '{"rows":[[2]]}',
  );
  assert.equal(await fetchText(report.url), '<h1>Sales</h1>');
  await assert.rejects(
    server.updateReport(
      report.id,
      'data',
      pack({ 'index.html': 'x' }).map((p) => p.file),
    ),
    /Only data files/,
  );

  // A site version replaces everything: files it doesn't list are gone.
  await upload(server, pack({ 'index.html': '<h1>New</h1>' }), (files) =>
    server.updateReport(report.id, 'site', files),
  );
  assert.equal(await fetchText(report.url), '<h1>New</h1>');
  assert.equal(await fetchText(new URL('data/sales.json', report.url)), '404');

  // The version left uncompleted above is older than the live one now: it can't come back.
  await assert.rejects(
    server.completeUpload(report.id, next.version),
    /newer version is already live/,
  );
});

test('S3 only takes the file the URL was signed for', async () => {
  const { token } = await pawpawServer(stub.url).signUp(
    'di@example.com',
    'password2',
  );
  const server = pawpawServer(stub.url, token);
  const [packed] = pack({ 'index.html': 'real' });
  const { uploads } = await server.createReport('X', [packed.file]);
  const [other] = pack({ 'index.html': 'swapped' });
  await assert.rejects(
    server.putFile(uploads[0], other.body),
    /failed \(400\)/,
  );
  await assert.rejects(
    server.putFile(
      {
        ...uploads[0],
        headers: { ...uploads[0].headers, 'Content-Type': 'text/javascript' },
      },
      packed.body,
    ),
    /failed \(403\)/,
  );
});

test("other accounts can't change a report, and unsafe paths are refused", async () => {
  const owner = pawpawServer(
    stub.url,
    (await pawpawServer(stub.url).signUp('ed@example.com', 'password3')).token,
  );
  const report = await upload(owner, pack({ 'index.html': 'mine' }), (files) =>
    owner.createReport('Mine', files),
  );
  const other = pawpawServer(
    stub.url,
    (await pawpawServer(stub.url).signUp('fi@example.com', 'password4')).token,
  );
  await assert.rejects(
    other.updateReport(
      report.id,
      'site',
      pack({ 'index.html': 'theirs' }).map((p) => p.file),
    ),
    /no report with that ID/,
  );
  await assert.rejects(
    owner.createReport(
      'Bad',
      pack({ '../escape.html': 'x' }).map((p) => p.file),
    ),
    /Unsafe path/,
  );
  await assert.rejects(owner.getReport('../x'), /Invalid report ID/);
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

test('uploading reports progress as each file finishes', async () => {
  const { token } = await pawpawServer(stub.url).signUp(
    'gu@example.com',
    'password5',
  );
  const server = pawpawServer(stub.url, token);
  const packed = pack({
    'index.html': '<h1>A</h1>',
    'pages/a.html': '<p>a</p>',
    'data/a.json': '{"rows":[]}',
  });
  const { report, version, uploads } = await server.createReport(
    'Progress',
    packed.map((p) => p.file),
  );
  const seen: [number, number][] = [];
  await uploadFiles(server, packed, uploads, (sent, total) =>
    seen.push([sent, total]),
  );
  const total = packed.reduce((sum, p) => sum + p.body.length, 0);
  assert.deepEqual(seen[0], [0, total]);
  assert.deepEqual(seen.at(-1), [total, total]);
  assert.equal(seen.length, 4, 'a step per file');
  assert.ok((await server.completeUpload(report.id, version)).publishedAt);
});
