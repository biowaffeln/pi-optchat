import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fork as forkProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { Memory, end, start, type Compression, type Entry } from '../src/memory.ts';
import { FileStore } from '../src/store.ts';
import { closeInfo, liveLock, liveStatus, listBranches, mergeBranch, openBranchMemory, readInfo, recoverBranches, resetBranch, saveInfo, startBranch, trunkState } from '../src/branch.ts';
import { holder, lockPath, takeLock, LockBusy, waitLock } from '../src/locks.ts';

// Short paths: lock sockets have a ~103-byte limit on macOS.
const home = () => mkdtempSync('/tmp/oc-br-');
const compress = async ({ source, part }: Compression) => `${part.l ? 'merge' : 'leaf'} ${start(part)}+${2 ** part.l}: ${source.slice(0, 60).replace(/\s+/g, ' ')}`;
const long = (label: string) => `${label} ${'some detail about it, '.repeat(30)}`;
const silent = () => {};

async function trunkWith(profile: string, messages: number) {
  const memory = new Memory(profile, compress, silent);
  for (let k = 0; k < messages; k++) memory.append('user', long(`trunk ${k}`), new Date(2026, 0, 1, 0, k).toISOString());
  await memory.settle(AbortSignal.timeout(10_000), 'tree');
  await memory.close();
}
const trunkLog = (profile: string) => (new FileStore(profile, silent).load().entries as Entry[]).sort((a, b) => a.i - b.i);
const trunkTree = (profile: string) => new FileStore(profile, silent).load().tree as { l: number; i: number; text: string }[];

async function branch(profile: string, cwd = '/work/a') {
  const started = await startBranch(profile, cwd, silent);
  const memory = await openBranchMemory(profile, started.dir, started.info, compress, silent);
  return { ...started, memory };
}

test('a branch starts from the trunk: same messages, nodes and view, and writes only its own folder', async () => {
  const profile = home();
  await trunkWith(profile, 20);
  const trunkView = readFileSync(join(profile, 'view.json'), 'utf8');
  const a = await branch(profile);
  try {
    assert.equal(a.info.base, 20);
    assert.equal(a.memory.root.length, 20);
    assert.ok(trunkView.length > 0);
    const before = new Memory(profile, compress, silent, undefined, 0);
    assert.equal(a.memory.render(), before.render(), 'a new branch shows what the trunk shows');
    await before.close();
    a.memory.append('user', long('branch 0'));
    await a.memory.settle(AbortSignal.timeout(10_000), 'tree');
    assert.equal(trunkLog(profile).length, 20, 'the trunk is untouched until a merge');
    assert.equal((new FileStore(a.dir, silent).load().entries as Entry[]).map(e => e.i).join(), '20', 'the branch logs only its own messages');
    assert.equal(a.memory.zoom(3, 1).startsWith('3+1|user: trunk 3'), true, 'zoom reaches the trunk\'s messages');
  } finally { await a.memory.close(); await a.release(); }
});

test('a merge with nothing in between keeps every node: the trunk is the branch\'s log, and needs nothing rebuilt', async () => {
  const profile = home();
  await trunkWith(profile, 10);
  const a = await branch(profile);
  try {
    for (let k = 0; k < 13; k++) a.memory.append(k % 2 ? 'talk' : 'user', long(`branch ${k}`), new Date(2026, 0, 2, 0, k).toISOString());
    await a.memory.settle(AbortSignal.timeout(10_000), 'tree');
    const result = await mergeBranch(profile, a.dir, a.info, a.memory.root, a.memory.tree.values(), 'close', silent);
    assert.deepEqual(result, { added: 13, at: 10, length: 23, moved: false, copied: result.copied });
    const log = trunkLog(profile);
    assert.deepEqual(log.slice(10).map(e => [e.i, e.text, e.date, e.branch?.i]), a.memory.root.slice(10).map(e => [e.i, e.text, e.date, e.i]), 'same ids, texts and dates');
    const trunk = new Memory(profile, () => Promise.reject(new Error('should not summarize')), silent, undefined, 0);
    assert.equal(trunk.tree.size, a.memory.tree.size, 'every node of the branch is a trunk node');
    assert.equal(trunk.render(), a.memory.render(), 'the trunk now shows what the branch showed');
    await trunk.close();
    const again = await mergeBranch(profile, a.dir, a.info, a.memory.root, a.memory.tree.values(), 'close', silent);
    assert.equal(again.added, 0, 'merging again adds nothing');
    assert.equal(trunkLog(profile).length, 23);
  } finally { await a.memory.close(); await a.release(); }
});

test('two branches at once: the second merge goes after the first as one block, keeps what still fits, and the rest is rebuilt', async () => {
  const profile = home();
  await trunkWith(profile, 9);
  const a = await branch(profile, '/work/a'), b = await branch(profile, '/work/b');
  try {
    assert.equal(a.info.base, 9); assert.equal(b.info.base, 9);
    for (let k = 0; k < 5; k++) a.memory.append('user', long(`a ${k}`));
    for (let k = 0; k < 8; k++) b.memory.append('user', long(`b ${k}`));
    await Promise.all([a.memory.settle(AbortSignal.timeout(10_000), 'tree'), b.memory.settle(AbortSignal.timeout(10_000), 'tree')]);
    await mergeBranch(profile, a.dir, a.info, a.memory.root, a.memory.tree.values(), 'close', silent);
    const result = await mergeBranch(profile, b.dir, b.info, b.memory.root, b.memory.tree.values(), 'close', silent);
    // b's messages 9..16 go after a's (9..13) and a note saying where they came from (14): 15..22, a shift of 6.
    assert.deepEqual(result, { added: 8, at: 14, length: 23, moved: true, copied: result.copied });
    const log = trunkLog(profile);
    assert.equal(log.length, 23);
    assert.match(log[14].text, /^Another session's messages follow: branch [0-9a-f]+, in \/work\/b/);
    assert.equal(log[14].kind, 'note');
    assert.deepEqual(log.slice(15).map(e => e.text), b.memory.root.slice(9).map(e => e.text));
    const tree = trunkTree(profile);
    for (const node of tree) assert.ok(end(node) <= 23, 'no node beyond the log');
    const leaves = tree.filter(n => n.l === 0 && n.i >= 15);
    assert.equal(leaves.length, 8, 'every leaf of b moved with its message');
    assert.ok(leaves.every(n => n.text.startsWith(`leaf ${n.i - 6}+1: user: b ${n.i - 15}`)), 'each leaf is the summary b built');
    assert.ok(tree.some(n => n.l === 1 && n.i === 8), 'a pair that moved by an even shift kept its node (b\'s 10-11 is now 16-17)');
    // The rest is built by whoever needs it next: here a trunk memory that summarizes.
    const trunk = new Memory(profile, compress, silent);
    await trunk.settle(AbortSignal.timeout(10_000), 'tree');
    assert.equal(trunk.root.length, 23);
    await trunk.close();
  } finally { await a.memory.close(); await b.memory.close(); await a.release(); await b.release(); }
});

test('a branch can merge while idle and again later; each merge adds only what is new', async () => {
  const profile = home();
  await trunkWith(profile, 4);
  const a = await branch(profile);
  try {
    a.memory.append('user', long('first'));
    await mergeBranch(profile, a.dir, a.info, a.memory.root, a.memory.tree.values(), 'idle', silent);
    a.memory.append('user', long('second')); a.memory.append('talk', long('third'));
    const result = await mergeBranch(profile, a.dir, a.info, a.memory.root, a.memory.tree.values(), 'close', silent);
    assert.deepEqual(result, { added: 2, at: 5, length: 7, moved: false, copied: result.copied });
    assert.deepEqual(trunkLog(profile).map(e => e.branch?.i ?? null), [null, null, null, null, 4, 5, 6]);
  } finally { await a.memory.close(); await a.release(); }
});

test('a branch whose Pi died is merged as interrupted the next time the profile opens, with its unlogged input', async () => {
  const profile = home();
  await trunkWith(profile, 3);
  const a = await branch(profile);
  a.memory.append('user', long('logged'));
  await a.memory.settle(AbortSignal.timeout(10_000), 'tree');
  writeFileSync(join(a.dir, 'pending-inputs.json'), JSON.stringify([{ id: 'r1', text: 'typed but never answered', date: new Date().toISOString() }]));
  await a.memory.close();
  assert.equal(await recoverBranches(profile, silent).then(ids => ids.length), 0, 'a live branch is left alone');
  await a.release(); // as if its process died: the OS drops the socket
  assert.deepEqual(await recoverBranches(profile, silent), [a.info.id]);
  const log = trunkLog(profile);
  assert.deepEqual(log.slice(3).map(e => [e.kind, e.text.slice(0, 24)]), [['user', long('logged').slice(0, 24)], ['user', 'typed but never answered'], ['note', `Branch ${a.info.id} (in /work/`]]);
  assert.ok(readInfo(a.dir)?.closed, 'marked closed');
  assert.deepEqual(await recoverBranches(profile, silent), [], 'and not recovered twice');
});

test('a rebase merges everything and starts again from the trunk\'s end, keeping the branch id', async () => {
  const profile = home();
  await trunkWith(profile, 6);
  let a = await branch(profile, '/work/a');
  const b = await branch(profile, '/work/b');
  try {
    b.memory.append('user', long('b says hi'));
    await mergeBranch(profile, b.dir, b.info, b.memory.root, b.memory.tree.values(), 'close', silent);
    a.memory.append('user', long('a works'));
    assert.equal((await trunkState(profile, silent)).foreign(a.info.id, a.info.base), true, 'the trunk has something a hasn\'t seen');
    await mergeBranch(profile, a.dir, a.info, a.memory.root, a.memory.tree.values(), 'rebase', silent);
    await a.memory.close();
    const state = await trunkState(profile, silent);
    resetBranch(a.dir, a.info, state.length, state.view);
    const memory = await openBranchMemory(profile, a.dir, a.info, compress, silent);
    a = { ...a, memory };
    assert.equal(a.info.base, 9, 'trunk 6 + b 1 + note 1 + a 1');
    assert.ok(a.memory.root.some(e => e.text.startsWith('b says hi')), 'a now sees b');
    a.memory.append('user', long('a goes on'));
    const result = await mergeBranch(profile, a.dir, a.info, a.memory.root, a.memory.tree.values(), 'close', silent);
    assert.deepEqual(result, { added: 1, at: 9, length: 10, moved: false, copied: result.copied });
    assert.deepEqual(trunkLog(profile).filter(e => e.branch?.id === a.info.id).map(e => [e.i, e.branch!.i]), [[8, 6], [9, 9]]);
    assert.ok(existsSync(join(a.dir, 'rebased', '6', 'main')), 'the old log is kept aside');
  } finally { await a.memory.close(); await b.memory.close(); await a.release(); await b.release(); }
});

test('live branches answer on their lock; closed ones are listed but not live', async () => {
  const profile = home();
  await trunkWith(profile, 1);
  const a = await branch(profile), b = await branch(profile);
  a.setStatus({ cwd: '/work/a', note: 'busy' });
  assert.deepEqual(listBranches(profile).map(i => i.id).sort(), [a.info.id, b.info.id].sort());
  assert.equal((await liveStatus(profile, a.info.id))?.note, 'busy');
  await b.memory.close(); await b.release(); closeInfo(b.dir, b.info);
  assert.equal(await liveStatus(profile, b.info.id), undefined);
  await assert.rejects(takeLock(liveLock(a.dir), () => 'x'), LockBusy);
  await a.memory.close(); await a.release();
});

test('the trunk lock serializes merges from several processes, and a dead holder never blocks it', { timeout: 20_000 }, async () => {
  const dir = home(), path = lockPath(dir, 'trunk');
  const holderChild = forkProcess(new URL('./fixtures/hold-lock.ts', import.meta.url).pathname, [path], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await once(holderChild, 'message');
  assert.equal(await holder(path), 'child');
  await assert.rejects(waitLock(path, () => 'me', 300), LockBusy);
  holderChild.kill('SIGKILL'); await once(holderChild, 'exit');
  const release = await waitLock(path, () => 'me', 2000);
  assert.equal(await holder(path), 'me');
  await release();
});

test('a new session takes over the runs of closed sessions (the first one also those from before branches), but not of open ones', async () => {
  const profile = home();
  await trunkWith(profile, 2);
  mkdirSync(join(profile, 'runs'));
  writeFileSync(join(profile, 'runs', 'old.jsonl'), '{}\n'); writeFileSync(join(profile, 'runs', 'old.optchat.json'), '{}');
  const open = await branch(profile), closed = await branch(profile);
  try {
    for (const b of [open, closed]) { mkdirSync(join(b.dir, 'runs'), { recursive: true }); writeFileSync(join(b.dir, 'runs', `${b.info.id}.optchat.json`), '{}'); }
    await closed.memory.close(); closeInfo(closed.dir, closed.info); await closed.release();
    const next = await branch(profile);
    try {
      assert.deepEqual(readdirSync(join(next.dir, 'runs')), [`${closed.info.id}.optchat.json`]);
      assert.deepEqual(readdirSync(join(open.dir, 'runs')).sort(), [`${open.info.id}.optchat.json`, 'old.jsonl', 'old.optchat.json'].sort(),
        'the first session took the profile\'s old runs, and keeps them and its own while it is open');
      assert.deepEqual(readdirSync(join(profile, 'runs')), []);
    } finally { await next.memory.close(); await next.release(); }
  } finally { await open.memory.close(); await open.release(); }
});

test('recovery leaves alone a branch that closed while it waited, one from another host, and one whose journal it cannot read', async () => {
  const profile = home();
  await trunkWith(profile, 2);
  // Listed as open, then closed normally before recovery got its lock: no "ended without closing" note.
  const a = await branch(profile);
  a.memory.append('user', 'said in a'); await a.memory.close();
  await mergeBranch(profile, a.dir, a.info, a.memory.root, a.memory.tree.values(), 'close', silent);
  const stale = { ...a.info };
  closeInfo(a.dir, a.info); await a.release();
  writeFileSync(join(a.dir, 'branch.json'), JSON.stringify({ ...stale, closed: undefined }));
  const recovering = recoverBranches(profile, silent);
  closeInfo(a.dir, a.info); // it really did close; the listing above just saw it a moment too early
  await recovering;
  const other = await branch(profile);
  other.memory.append('user', 'said on another machine'); await other.memory.close();
  saveInfo(other.dir, { ...other.info, host: 'elsewhere' }); await other.release();
  const broken = await branch(profile);
  broken.memory.append('user', 'said before the journal broke'); await broken.memory.close();
  writeFileSync(join(broken.dir, 'pending-inputs.json'), '[{"id": "half');
  await broken.release();
  const warnings: string[] = [];
  assert.deepEqual(await recoverBranches(profile, w => warnings.push(w)), []);
  assert.ok(!trunkLog(profile).some(e => /ended without closing/.test(e.text)), 'no note for a branch that closed');
  assert.match(warnings.join('\n'), /runs on elsewhere/);
  assert.match(warnings.join('\n'), new RegExp(`Could not recover branch ${broken.info.id}`));
  assert.ok(!readInfo(other.dir)?.closed && !readInfo(broken.dir)?.closed, 'both stay to be recovered later');
  assert.ok(!trunkLog(profile).some(e => e.text === 'said before the journal broke'));
});

test('an interrupted branch that said nothing new adds no note', async () => {
  const profile = home();
  await trunkWith(profile, 2);
  const a = await branch(profile);
  await a.memory.close(); await a.release();
  assert.deepEqual(await recoverBranches(profile, silent), [a.info.id]);
  assert.equal(trunkLog(profile).length, 2);
});
