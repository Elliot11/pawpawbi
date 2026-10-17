// The assistant's change journal (src/assistant/changes.ts): recording, rolling back a failed
// change, undo back to a point, and warning about files edited since.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { ChangeJournal } from '../../src/assistant/changes.ts';

let tmp: string;
let root: string;
let journal: ChangeJournal;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pawpaw-changes-'));
  root = path.join(tmp, 'project');
  await fs.mkdir(path.join(root, 'report', 'pages'), { recursive: true });
  await fs.mkdir(path.join(root, 'report', 'data'), { recursive: true });
  await fs.mkdir(path.join(root, 'model'), { recursive: true });
  await write('report/report.json', '{"pages":[]}');
  await write('report/data/big.json', 'data');
  journal = new ChangeJournal(root, path.join(tmp, 'undo'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
});

const write = async (relative: string, content: string) => {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), content);
};
const read = (relative: string) =>
  fs.readFile(path.join(root, relative), 'utf8').catch(() => null);
const site = { dir: 'report', exclude: ['data'] };

test('a change is recorded and undone, including files it created', async () => {
  const { record } = await journal.record('Added a page', [site], async () => {
    await write('report/report.json', '{"pages":["a"]}');
    await write('report/pages/a.html', '<h1>A</h1>');
  });
  assert.equal(record.summary, 'Added a page');
  assert.equal(await read('report/pages/a.html'), '<h1>A</h1>');

  await journal.undoBackTo(record.id);
  assert.equal(await read('report/report.json'), '{"pages":[]}');
  assert.equal(
    await read('report/pages/a.html'),
    null,
    'the created page is removed',
  );
  assert.equal((await journal.list())[0].undone, true);
});

test('files a change deleted come back on undo', async () => {
  await write('report/pages/a.html', '<h1>A</h1>');
  const { record } = await journal.record('Deleted a page', [site], () =>
    fs.rm(path.join(root, 'report/pages/a.html')),
  );
  await journal.undoBackTo(record.id);
  assert.equal(await read('report/pages/a.html'), '<h1>A</h1>');
});

test('a failed change is put back at once and not recorded', async () => {
  await assert.rejects(
    journal.record('Broke things', [site], async () => {
      await write('report/report.json', 'half written');
      await write('report/pages/new.html', 'x');
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await read('report/report.json'), '{"pages":[]}');
  assert.equal(await read('report/pages/new.html'), null);
  assert.deepEqual(await journal.list(), []);
});

test('undo back to a change reverts it and every later one, newest first', async () => {
  const first = await journal.record('One', [site], () =>
    write('report/report.json', '1'),
  );
  const second = await journal.record('Two', [site], () =>
    write('report/report.json', '2'),
  );
  const third = await journal.record(
    'Three',
    [{ file: 'model/datasets.json' }],
    () => write('model/datasets.json', '{}'),
  );

  const undone = await journal.undoBackTo(second.record.id);
  assert.deepEqual(
    undone.map((c) => c.summary),
    ['Two', 'Three'],
  );
  assert.equal(await read('report/report.json'), '1');
  assert.equal(await read('model/datasets.json'), null);
  assert.deepEqual(
    (await journal.list()).map((c) => [c.summary, c.undone]),
    [
      ['One', false],
      ['Two', true],
      ['Three', true],
    ],
  );
  await assert.rejects(
    journal.undoBackTo(third.record.id),
    /already been undone/,
  );
  assert.ok(first);
});

test('excluded folders are left alone', async () => {
  const { record } = await journal.record('Page and data', [site], async () => {
    await write('report/report.json', 'changed');
    await write('report/data/big.json', 'changed outside the change');
  });
  await journal.undoBackTo(record.id);
  assert.equal(await read('report/report.json'), '{"pages":[]}');
  assert.equal(
    await read('report/data/big.json'),
    'changed outside the change',
  );
});

test('files edited since the change are reported before undoing', async () => {
  const { record } = await journal.record('Wrote a page', [site], () =>
    write('report/pages/a.html', 'by the assistant'),
  );
  assert.deepEqual(await journal.conflicts(record.id), []);
  await write('report/pages/a.html', 'edited by the user');
  assert.deepEqual(await journal.conflicts(record.id), ['report/pages/a.html']);
});

test('the record survives reopening the journal', async () => {
  const { record } = await journal.record('One', [site], () =>
    write('report/report.json', '1'),
  );
  const reopened = new ChangeJournal(root, path.join(tmp, 'undo'));
  assert.equal((await reopened.list())[0].id, record.id);
  await reopened.undoBackTo(record.id);
  assert.equal(await read('report/report.json'), '{"pages":[]}');
});

test('file names with spaces are fine', async () => {
  const { record } = await journal.record('Logo', [site], () =>
    write('report/assets/my logo.png', 'png'),
  );
  await journal.undoBackTo(record.id);
  assert.equal(await read('report/assets/my logo.png'), null);
});

test('paths outside the project are refused', async () => {
  await assert.rejects(
    journal.record('Escape', [{ file: '../outside.txt' }], async () => {}),
    /Invalid path/,
  );
});
