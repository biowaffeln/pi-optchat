import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { Memory } from '../src/memory.ts';
import { openBranchMemory, recoverBranches, startBranch } from '../src/branch.ts';
import { lastLines, livePeers, logNotes, noteLabel, notePeer, noteReceipt, notesText, peekNotes, peersText, publishTurn, publishView, takeNotes, turnLines } from '../src/peers.ts';

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
    try { assert.deepEqual(trunk.root.filter(e => e.text === `[note from ${a.info.id} (/work/a)] heads up: the schema changed`).map(e => e.kind), ['note']); }
    finally { await trunk.close(); }
  } finally { await a.memory.close(); await a.release(); }
});

test('a note logged before its read mark moved (a crash in between) is logged once by the recovery, as a note', async () => {
  const { profile, a, b } = await setup();
  try {
    await notePeer(profile, { id: a.info.id, cwd: '/work/a' }, b.info.id, 'first');
    await notePeer(profile, { id: a.info.id, cwd: '/work/a' }, b.info.id, 'second');
    const { notes } = peekNotes(b.dir);
    // b showed and logged the first one, then died before moving the read mark; the second it never got to.
    logNotes(b.memory, notes.slice(0, 1));
    logNotes(b.memory, notes.slice(0, 1));
    assert.equal(b.memory.root.filter(e => e.receipt === noteReceipt(notes[0])).length, 1, 'logNotes skips one memory has');
    await b.memory.close(); await b.release();
    assert.deepEqual(await recoverBranches(profile, silent), [b.info.id]);
    const trunk = new Memory(profile, compress, silent);
    try {
      const logged = trunk.root.filter(e => e.text.startsWith('[note from '));
      assert.deepEqual(logged.map(e => [e.kind, e.text]), [['note', `[note from ${a.info.id} (/work/a)] first`], ['note', `[note from ${a.info.id} (/work/a)] second`]]);
    } finally { await trunk.close(); }
  } finally { await a.memory.close(); await a.release(); }
});

test('a note is labelled with its sender\'s id and folder, the home folder as ~', () => {
  assert.equal(noteLabel({ from: '55d82d', cwd: '/Users/mark/src/pi-optchat' }, '/Users/mark'), 'note from 55d82d · ~/src/pi-optchat');
  assert.equal(noteLabel({ from: '55d82d', cwd: '/Users/mark' }, '/Users/mark'), 'note from 55d82d · ~');
  assert.equal(noteLabel({ from: '55d82d', cwd: '/Users/markus' }, '/Users/mark'), 'note from 55d82d · /Users/markus');
  const note = { from: '55d82d', cwd: '/w', text: 'hi', date: '2026-10-25T09:00:00.000Z' };
  assert.equal(noteReceipt(note), noteReceipt({ ...note }));
  assert.notEqual(noteReceipt(note), noteReceipt({ ...note, text: 'hi!' }));
});
