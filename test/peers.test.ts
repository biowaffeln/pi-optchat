import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { Memory } from '../src/memory.ts';
import { openBranchMemory, recoverBranches, startBranch } from '../src/branch.ts';
import { lastLines, livePeers, notePeer, notesText, peersText, publishTurn, publishView, takeNotes, turnLines } from '../src/peers.ts';

const silent = () => {};
const compress = async () => 'a line';

async function setup() {
  const profile = mkdtempSync('/tmp/oc-peer-');
  const trunk = new Memory(profile, compress, silent); trunk.append('user', 'hello'); await trunk.close();
  const open = async (cwd: string) => {
    const b = await startBranch(profile, cwd, silent);
    const memory = await openBranchMemory(profile, b.dir, b.info, compress, silent);
    return { ...b, memory };
  };
  return { profile, a: await open('/work/a'), b: await open('/work/b') };
}

test('peers lists the other live sessions with their cwd and last view lines, and not itself or closed ones', async () => {
  const { profile, a, b } = await setup();
  try {
    b.memory.append('user', 'renaming /auth/refresh to /session/refresh');
    await b.memory.settle();
    b.setStatus({ cwd: '/work/b', lines: lastLines(b.memory.render()), working: true });
    const peers = await livePeers(profile, a.info.id);
    assert.deepEqual(peers.map(p => [p.id, p.cwd, p.working]), [[b.info.id, '/work/b', true]]);
    assert.deepEqual(peers[0].lines, ['0+1|user: hello', '1+1|user: renaming /auth/refresh to /session/refresh']);
    assert.match(peersText(peers), new RegExp(`^${b.info.id} · /work/b · started .* · working\n  0\\+1\\|user: hello`));
    await b.release();
    assert.equal(peersText(await livePeers(profile, a.info.id)), 'No other session is open on this profile.');
  } finally { await a.memory.close(); await b.memory.close(); await a.release(); await b.release(); }
});

test('a note goes to a live peer only, at most 280 bytes, and is taken once, in order', async () => {
  const { profile, a, b } = await setup();
  try {
    await notePeer(profile, { id: a.info.id, cwd: '/work/a' }, b.info.id, 'heads up: /auth/refresh is now\n/session/refresh');
    await notePeer(profile, { id: a.info.id, cwd: '/work/a' }, b.info.id, 'and it returns a JWT');
    await assert.rejects(notePeer(profile, { id: a.info.id, cwd: '/work/a' }, b.info.id, 'x'.repeat(281)), /281 bytes; notes are at most 280/);
    await assert.rejects(notePeer(profile, { id: a.info.id, cwd: '/work/a' }, a.info.id, 'me'), /is this session/);
    await assert.rejects(notePeer(profile, { id: a.info.id, cwd: '/work/a' }, 'zzzzzz', 'nobody'), /ids are the 6-character ones/);
    const notes = takeNotes(b.dir);
    assert.equal(notesText(notes), `[note from ${a.info.id} (/work/a)] heads up: /auth/refresh is now /session/refresh\n[note from ${a.info.id} (/work/a)] and it returns a JWT`);
    assert.deepEqual(takeNotes(b.dir), [], 'taken once');
    await b.release();
    await assert.rejects(notePeer(profile, { id: a.info.id, cwd: '/work/a' }, b.info.id, 'too late'), /is not open/);
  } finally { await a.memory.close(); await b.memory.close(); await a.release(); await b.release(); }
});

test('a published view is what ask_peer reads', async () => {
  const { a, b } = await setup();
  try {
    publishView(b.dir, b.memory.render());
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(`${b.dir}/view.txt`, 'utf8'), b.memory.render());
  } finally { await a.memory.close(); await b.memory.close(); await a.release(); await b.release(); }
});

test('a running turn is published as short lines, newest last and bounded, and cleared when it ends', () => {
  const dir = mkdtempSync('/tmp/oc-peer-');
  const user = (text: string) => ({ role: 'user' as const, content: text, timestamp: 0 });
  publishTurn(dir, [user('migrating billing to postgres 17'), user(`long ${'x'.repeat(2000)}`)]);
  const lines = turnLines(dir);
  assert.equal(lines[0], 'user: migrating billing to postgres 17');
  assert.ok(lines[1].endsWith('...') && Buffer.byteLength(lines[1]) <= 515, 'a long message is cut to one line');
  publishTurn(dir, Array.from({ length: 100 }, (_, k) => user(`${k} ${'y'.repeat(400)}`)));
  const many = turnLines(dir);
  assert.ok(many.join('\n').length <= 16_000 && many.at(-1)!.startsWith('user: 99 '), 'the newest are kept');
  publishTurn(dir, []);
  assert.deepEqual(turnLines(dir), []);
});

test('a note no input carried goes into the receiving session\'s memory when it closes, or when a crashed one is recovered', async () => {
  const { profile, a, b } = await setup();
  try {
    await notePeer(profile, { id: a.info.id, cwd: '/work/a' }, b.info.id, 'heads up: the schema changed');
    // b's Pi died: its lock is gone, it never closed.
    await b.memory.close(); await b.release();
    assert.deepEqual(await recoverBranches(profile, silent), [b.info.id]);
    const trunk = new Memory(profile, compress, silent);
    try { assert.ok(trunk.root.some(e => e.kind === 'user' && e.text === `[note from ${a.info.id} (/work/a)] heads up: the schema changed`)); }
    finally { await trunk.close(); }
  } finally { await a.memory.close(); await a.release(); }
});
