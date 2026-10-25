import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, type Entry, type Summary } from '../src/memory.ts';
import { FileStore, localDay, type Saved, type Store } from '../src/store.ts';
import { removeDir } from './support.ts';

const entry = (i: number, text: string): Entry => ({ i, kind: 'user', text, size: 0, date: '2026-10-09T12:00:00.000Z' });
const node = (i: number, text: string): Summary => ({ l: 0, i, text, size: 0 });
const temp = () => mkdtempSync(join(tmpdir(), 'optchat-store-'));

/** What every store must do, so a new one can run the same checks against itself. */
function contract(name: string, open: (dir: string, warn: (s: string) => void) => Store) {
  test(`${name}: what is written loads back, in order, in a fresh store`, async () => {
    const dir = temp();
    try {
      const store = open(dir, () => {});
      await store.load();
      for (const [i, text] of ['one', 'two', 'three'].entries()) await store.append(entry(i, text));
      await store.appendNode(node(0, 'first summary'));
      await store.saveView('[[0,0]]'); await store.saveView('[[0,0],[0,1]]');
      const saved = await open(dir, () => {}).load();
      assert.deepEqual(saved.entries, ['one', 'two', 'three'].map((text, i) => entry(i, text)));
      assert.deepEqual(saved.tree, [node(0, 'first summary')]);
      assert.equal(saved.view, '[[0,0],[0,1]]');
    } finally { removeDir(dir); }
  });
  test(`${name}: a store refuses to append after another one appended`, async () => {
    const dir = temp();
    try {
      const a = open(dir, () => {}), b = open(dir, () => {});
      await a.load(); await b.load();
      await a.append(entry(0, 'from a'));
      await assert.rejects(async () => b.append(entry(0, 'from b')), /nothing was written/);
      assert.deepEqual((await open(dir, () => {}).load()).entries, [entry(0, 'from a')]);
    } finally { removeDir(dir); }
  });
  test(`${name}: images come back as they were put, and an unknown one is missing`, async () => {
    const dir = temp();
    try {
      const store = open(dir, () => {}), data = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      await store.load();
      await store.putImage('0123456789abcdef', 'image/png', data);
      const kept = await open(dir, () => {}).image('0123456789abcdef');
      assert.equal(kept?.mimeType, 'image/png');
      assert.deepEqual(Uint8Array.from(kept?.data ?? []), data);
      assert.equal(await store.image('fedcba9876543210'), undefined);
    } finally { removeDir(dir); }
  });
}
contract('FileStore', (dir, warn) => new FileStore(dir, warn));

test('FileStore: a line torn by a crash is skipped with a warning, and the next append starts on a fresh line', () => {
  const dir = temp();
  try {
    new FileStore(dir).load();
    const first = new FileStore(dir); first.load(); first.append(entry(0, 'kept'));
    appendFileSync(join(dir, 'main', `${localDay()}.jsonl`), '{"i":1,"kind":"us');
    const warnings: string[] = [], reopened = new FileStore(dir, text => warnings.push(text));
    assert.deepEqual(reopened.load().entries, [entry(0, 'kept')]);
    assert.match(warnings.join('\n'), /Skipped damaged JSON at .*:2/);
    reopened.append(entry(1, 'after the crash'));
    assert.deepEqual(new FileStore(dir, () => {}).load().entries, [entry(0, 'kept'), entry(1, 'after the crash')]);
  } finally { removeDir(dir); }
});

/** A store that writes behind, each write landing sooner than the one before it, unless it was started while `fail` was set. */
function behind() {
  const landed: string[] = [];
  let fail = false, delay = 20;
  const later = (text: string) => {
    const failing = fail, ms = Math.max(1, delay -= 3);
    return new Promise<void>((resolve, reject) => setTimeout(() => failing ? reject(new Error('offline')) : (landed.push(text), resolve()), ms));
  };
  const store: Store = {
    load: async (): Promise<Saved> => ({ entries: [], tree: [] }),
    append: e => later(e.text), appendNode: n => later(`node ${n.i}`), saveView: () => later('view'),
    putImage: () => later('image'), image: async () => undefined,
  };
  return { store, landed, failing: (on: boolean) => { fail = on; } };
}

test('a store that writes behind gets its writes one at a time, in the order Memory made them', async () => {
  const { store, landed } = behind();
  const memory = new Memory({ directory: temp(), store, saved: await store.load() }, async () => 'unused', () => {});
  for (const text of ['one', 'two', 'three']) memory.append('user', text);
  assert.equal(landed.length, 0, 'appends return before their writes land');
  await memory.settle(undefined, 'tree'); await memory.close();
  assert.deepEqual(landed.filter(text => !text.startsWith('node') && text !== 'view'), ['one', 'two', 'three']);
  assert.ok(landed.indexOf('node 0') > landed.indexOf('one'), 'a node lands after its message');
});

test('once a write-behind append fails, nothing more is written, summary nodes included, even if the store recovers', async () => {
  const { store, landed, failing } = behind(), warnings: string[] = [];
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const memory = new Memory({ directory: temp(), store, saved: await store.load() }, async () => { await gate; return 'summary'; }, text => warnings.push(text));
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  await wait(30); landed.length = 0;
  // Long enough to need the compactor, so its node is written only after the failed append has settled and the queue is empty.
  failing(true); memory.append('user', 'lost '.repeat(200)); memory.append('user', 'queued behind it');
  await wait(60);
  assert.match(warnings.join('\n'), /Memory could not be saved: offline/);
  failing(false); release();
  await wait(60);
  assert.deepEqual(landed, [], 'no message, node or view is written after the failed append');
  assert.throws(() => memory.append('user', 'more'), /Memory could not be saved: offline/);
  await memory.close();
});
