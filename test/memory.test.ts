import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, Refused, cap, CAP, SOURCE, NODE, start, end, bytes, mostDue, type Compression, type Part } from '../src/memory.ts';
import { appendJson, localDay } from '../src/store.ts';
import { splitView, cachePayload } from '../src/cache.ts';
import { logMessage, buildContext, boundedMessage } from '../src/transcript.ts';
import { Inbox } from '../src/inbox.ts';
import { compaction } from '../src/prompts.ts';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import type { AssistantMessage, SystemMessage, UserMessage } from '@earendil-works/pi-ai';
import { removeDir } from './support.ts';

test('tree covers all history, fits incrementally, and exact originals survive restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-'));
  const calls: Compression[] = [];
  const compress = async (input: Compression) => { calls.push(input); return input.source.slice(0, 170); };
  let memory = new Memory(dir, compress, () => {}, 1500);
  try {
    for (let i = 0; i < 48; i++) memory.append('user', `Original ${i}: ${'valuable detail '.repeat(30)}`);
    await memory.settle(AbortSignal.timeout(5000), 'tree');
    assert.equal(start(memory.view[0]), 0);
    assert.equal(end(memory.view.at(-1)!), 48);
    for (let i = 1; i < memory.view.length; i++) assert.equal(end(memory.view[i - 1]), start(memory.view[i]));
    assert.ok(memory.size <= 1500);
    assert.ok(memory.view.some(p => p.l > 0));
    assert.ok(calls.every(c => !c.context.includes('not summarized yet')));
    assert.match(memory.zoom(17, 1), /Original 17:/);
    const originals = memory.root.map(e => e.text);
    const parts = [...memory.view];
    memory.append('talk', 'One short new reply.');
    await memory.settle(AbortSignal.timeout(5000), 'tree');
    for (const before of parts) assert.ok(memory.view.some(after => start(after) <= start(before) && end(after) >= end(before)));
    await memory.close();
    memory = new Memory(dir, compress, () => {}, 1500);
    await memory.settle(AbortSignal.timeout(5000), 'tree');
    assert.deepEqual(memory.root.slice(0, 48).map(e => e.text), originals);
    assert.match(memory.zoom(17, 1), /valuable detail/);
    assert.throws(() => memory.zoom(3, 4), /No line/);
  } finally { await memory.close(); removeDir(dir); }
});

test('zoom returns the built half when the other is not summarized yet, and a bad line lists the roots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-'));
  const memory = new Memory(dir, async () => { throw new Error('model unavailable'); }, () => {}, 128000, 8, 60_000);
  try {
    memory.append('user', 'A short question.');
    memory.append('talk', 'long answer '.repeat(100));
    memory.append('user', 'Thanks.');
    await memory.settle(AbortSignal.timeout(2000));
    assert.equal(memory.zoom(0, 2), '0+1|user: A short question.\n1+1|(not summarized yet: zoom it)');
    assert.throws(() => memory.zoom(1, 2), /No line 1\+2: .*roots: 0\+2, 2\+1\./);
  } finally { await memory.close(); removeDir(dir); }
});

test('a turn waits for pending summaries, goes on once they have all failed, and failures keep retrying', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')); let attempts = 0;
  let release = () => {};
  const retrying = new Promise<void>(resolve => { release = resolve; });
  const memory = new Memory(dir, async () => {
    if (++attempts === 1) throw new Error('model unavailable');
    await retrying; return 'user: retained decision';
  }, () => {}, 128000, 8, 100);
  try {
    memory.append('user', 'large message '.repeat(100));
    await memory.settle(AbortSignal.timeout(2000));
    assert.ok(!memory.ready, 'the turn goes on with a placeholder');
    assert.match(memory.render(), /not summarized yet/);
    assert.equal(memory.lastError, 'model unavailable');
    for (const deadline = Date.now() + 2000; attempts < 2 && Date.now() < deadline;) await new Promise(r => setTimeout(r, 10));
    assert.equal(attempts, 2, 'retried after the delay');
    // AbortSignal.timeout doesn't keep the event loop alive, and nothing else would while the retry hangs.
    const stop = new AbortController(); const timer = setTimeout(() => stop.abort(), 20);
    await assert.rejects(memory.settle(stop.signal), /cancelled/, 'a retry in flight is waited for');
    clearTimeout(timer);
    release();
    await memory.settle(AbortSignal.timeout(2000));
    assert.ok(memory.ready); assert.equal(memory.lastError, undefined);
  } finally { release(); await memory.close(); removeDir(dir); }
});

test('a tree wait (imports) keeps waiting through failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-'));
  const memory = new Memory(dir, async () => { throw new Error('down'); }, () => {}, 128000, 8, 60_000);
  try {
    memory.append('user', 'large message '.repeat(100));
    await assert.rejects(memory.settle(AbortSignal.timeout(100), 'tree'), /cancelled/);
    await memory.settle(AbortSignal.timeout(100));
  } finally { await memory.close(); removeDir(dir); }
});

test('a turn waits for the view to be built, not for merges that bring it under budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-'));
  let release = () => {};
  const merging = new Promise<void>(resolve => { release = resolve; });
  // Each 300-byte message is its own summary; merging two goes past 512 bytes, so it needs the compactor, which holds it.
  const memory = new Memory(dir, async input => { if (input.part.l) await merging; return 'merged'; }, () => {}, 500);
  try {
    memory.append('user', 'a'.repeat(300)); memory.append('user', 'b'.repeat(300));
    await memory.settle(AbortSignal.timeout(2000));
    assert.ok(memory.ready);
    assert.ok(memory.size > memory.budget, 'the view is still over budget while the merge is pending');
    release();
    await memory.settle(AbortSignal.timeout(2000), 'tree');
    assert.ok(memory.size <= memory.budget);
  } finally { release(); await memory.close(); removeDir(dir); }
});

test('progress counts summaries against the largest backlog since it was last empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-'));
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  // Every 600-byte message needs the compactor, which holds all of them until released.
  const memory = new Memory(dir, async () => { await gate; return 'summary'; }, () => {});
  try {
    assert.deepEqual(memory.progress(), { done: 0, total: 0, retryIn: undefined });
    memory.append('user', 'a'.repeat(600)); memory.append('user', 'b'.repeat(600));
    assert.deepEqual(memory.progress(), { done: 0, total: 3, retryIn: undefined }, 'two leaves and their parent');
    memory.append('user', 'c'.repeat(600)); memory.append('user', 'd'.repeat(600));
    assert.equal(memory.progress().total, 7, 'grows with the backlog');
    release();
    await memory.settle(AbortSignal.timeout(2000), 'tree');
    assert.deepEqual(memory.progress(), { done: 0, total: 0, retryIn: undefined }, 'resets when the backlog drains');
    memory.append('user', 'e'.repeat(600));
    assert.deepEqual(memory.progress(), { done: 0, total: 1, retryIn: undefined }, 'a new backlog starts from zero');
  } finally { release(); await memory.close(); removeDir(dir); }
});

test('torn final line is reported and the next append remains readable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')); let memory = new Memory(dir, async () => 'summary');
  memory.append('user', 'first'); await memory.close();
  appendFileSync(join(dir, 'main', `${localDay()}.jsonl`), '{"torn":');
  const warnings: string[] = [];
  memory = new Memory(dir, async () => 'summary', text => warnings.push(text));
  memory.append('user', 'second'); await memory.close();
  memory = new Memory(dir, async () => 'summary', () => {});
  try { assert.equal(warnings.length, 1); assert.deepEqual(memory.root.map(e => e.text), ['first', 'second']); }
  finally { await memory.close(); removeDir(dir); }
});

test('a second writer on one profile is refused before it writes, and the profile still opens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')), compress = async () => 'summary';
  const first = new Memory(dir, compress, () => {}), second = new Memory(dir, compress, () => {});
  try {
    first.append('user', 'from the first writer');
    const file = join(dir, 'main', `${localDay()}.jsonl`), before = readFileSync(file, 'utf8');
    assert.throws(() => second.append('user', 'from the second writer'), /Another process wrote .*nothing was written/);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(second.root.length, 0);
    assert.throws(() => second.append('user', 'a retry'), /Another process wrote/);
  } finally { await first.close(); await second.close(); }
  const reopened = new Memory(dir, compress, () => {});
  try { assert.deepEqual(reopened.root.map(e => e.text), ['from the first writer']); }
  finally { await reopened.close(); removeDir(dir); }
});

test('a second writer that has seen today\'s file is refused after the other appends to it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')), compress = async () => 'summary';
  const first = new Memory(dir, compress, () => {}); first.append('user', 'one');
  const second = new Memory(dir, compress, () => {});
  try {
    first.append('user', 'two');
    assert.throws(() => second.append('user', 'three'), /Another process wrote .*nothing was written/);
  } finally { await first.close(); await second.close(); }
  const reopened = new Memory(dir, compress, () => {});
  try { assert.deepEqual(reopened.root.map(e => e.text), ['one', 'two']); }
  finally { await reopened.close(); removeDir(dir); }
});

test('a day file that another process created first is caught, and an ordinary midnight rollover is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')), compress = async () => 'summary';
  mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 1, 23, 59) });
  const opened: Memory[] = [];
  try {
    const lone = new Memory(dir, compress, () => {}); opened.push(lone);
    lone.append('user', 'before midnight');
    mock.timers.setTime(new Date(2026, 0, 2, 0, 1).getTime());
    lone.append('user', 'after midnight');
    const a = new Memory(dir, compress, () => {}), b = new Memory(dir, compress, () => {}); opened.push(a, b);
    mock.timers.setTime(new Date(2026, 0, 3, 0, 1).getTime());
    b.append('user', 'b on the third');
    assert.throws(() => a.append('user', 'a on the third'), /Another process wrote .*2026-01-03\.jsonl/);
    b.append('user', 'b again');
  } finally { mock.timers.reset(); await Promise.all(opened.map(m => m.close())); }
  const reopened = new Memory(dir, compress, () => {});
  try { assert.deepEqual(reopened.root.map(e => e.text), ['before midnight', 'after midnight', 'b on the third', 'b again']); }
  finally { await reopened.close(); removeDir(dir); }
});

test('a second writer whose first write starts a new day file is refused when the other wrote an older day file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')), compress = async () => 'summary';
  mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 1, 12) });
  const opened: Memory[] = [];
  try {
    const a = new Memory(dir, compress, () => {}), b = new Memory(dir, compress, () => {}); opened.push(a, b);
    a.append('user', 'a on the first');
    mock.timers.setTime(new Date(2026, 0, 2, 12).getTime());
    assert.throws(() => b.append('user', 'b on the second'), /Another process wrote .*2026-01-02\.jsonl.*nothing was written/);
    assert.equal(b.root.length, 0);
  } finally { mock.timers.reset(); await Promise.all(opened.map(m => m.close())); }
  const reopened = new Memory(dir, compress, () => {});
  try { assert.deepEqual(reopened.root.map(e => e.text), ['a on the first']); }
  finally { await reopened.close(); removeDir(dir); }
});

test('appendJson appends without a size, and with one it refuses a file of any other size', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')), file = join(dir, 'log.jsonl');
  try {
    const one = appendJson(file, { n: 1 });
    assert.equal(one, readFileSync(file).length);
    const two = appendJson(file, { n: 2 }, one);
    assert.equal(two, readFileSync(file).length);
    assert.throws(() => appendJson(file, { n: 3 }, one), /nothing was written/);
    assert.equal(readFileSync(file, 'utf8'), '{"n":1}\n{"n":2}\n');
  } finally { removeDir(dir); }
});

test('two writers that each summarize the same log leave a tree that still loads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')), compress = async () => 'summary';
  const log = new Memory(dir, compress, () => {});
  for (let i = 0; i < 3; i++) log.append('user', `message ${i}`);
  await log.close();
  const a = new Memory(dir, compress, () => {}), b = new Memory(dir, compress, () => {});
  await Promise.all([a.settle(AbortSignal.timeout(5000), 'tree'), b.settle(AbortSignal.timeout(5000), 'tree')]);
  await Promise.all([a.close(), b.close()]);
  const tree = readFileSync(join(dir, 'tree', `${localDay()}.jsonl`), 'utf8').trim().split('\n');
  assert.ok(tree.length > a.tree.size, 'both writers saved the same nodes');
  const reopened = new Memory(dir, compress, () => {});
  try {
    await reopened.settle(AbortSignal.timeout(5000), 'tree');
    assert.equal(reopened.root.length, 3); assert.equal(reopened.tree.size, a.tree.size);
  } finally { await reopened.close(); removeDir(dir); }
});

test('the view goes in blocks of 4 lines, with marks on its last whole block, 20 and 40 blocks before it, and at the request\'s end', () => {
  const line = '0+1|summary of a decision\n';
  for (const quoted of [false, true]) {
    const view = '<chat>\n' + line.repeat(2000) + (quoted ? '0+1|the summary quotes </chat> in passing\n' : '') + line.repeat(3500) + '</chat>';
    const pieces = splitView(view);
    assert.equal(pieces.join(''), view);
    assert.ok(pieces.slice(0, -1).every(piece => piece.split('\n').length === 5), 'every block but the last holds 4 lines');
    assert.deepEqual(splitView(view.replace(/<\/chat>$/, line.repeat(3) + '</chat>')).slice(0, pieces.length - 1), pieces.slice(0, -1),
      'a view that grows at its end keeps every whole block');
    const payload = { system: [{ type: 'text', text: 'identity', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'zoom', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: view }, { type: 'text', text: 'new question', cache_control: { type: 'ephemeral' } }] }],
    };
    const output = cachePayload(payload) as typeof payload & { cache_control?: unknown };
    assert.equal((JSON.stringify(output).match(/cache_control/g) ?? []).length, 4, quoted ? 'a quoted closing tag keeps the marks' : 'plain view');
    assert.deepEqual(output.system.map(b => 'cache_control' in b), [false, true], 'the system prompt is marked once, on its last block');
    assert.ok(!('cache_control' in output.tools[0]), 'the tools come before the system prompt, so its mark covers them');
    const blocks = output.messages[0].content;
    assert.deepEqual(blocks.flatMap((b, j) => 'cache_control' in b ? [j] : []), [pieces.length - 22, pieces.length - 2, blocks.length - 1]);
    assert.equal(output.cache_control, undefined, 'no top-level automatic mark');
    assert.deepEqual(blocks.at(-1)!.cache_control, { type: 'ephemeral' }, 'the end mark sits on the last block');
    assert.equal(blocks.map(b => b.text).join(''), view + 'new question');
  }
});

test('a subagent\'s task goes in its own block after the view, so siblings with different tasks mark the same view blocks', () => {
  const view = '<chat>\n' + '0+1|summary of a decision\n'.repeat(200) + '</chat>';
  const first = (task: string) => {
    const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: `${view}\n\nYour task:\n${task}` }] }] };
    return (cachePayload(payload) as { messages: { content: { text: string, cache_control?: unknown }[] }[] }).messages[0].content;
  };
  const [a, b] = [first('Review the PR.\nThen report.\nKeep it short.\nNo merge.\nThanks.'), first('Fix #196.')];
  const viewMarks = (blocks: typeof a) => blocks.slice(0, -1).map(block => [block.text, 'cache_control' in block]);
  assert.deepEqual(viewMarks(a), viewMarks(b), 'the same view blocks with the same marks');
  assert.equal(a.slice(0, -1).map(block => block.text).join(''), view);
  assert.deepEqual(a.at(-1), { type: 'text', text: '\n\nYour task:\nReview the PR.\nThen report.\nKeep it short.\nNo merge.\nThanks.', cache_control: { type: 'ephemeral' } });
});

test('a request with no status line marks its last block, not the top level, so a 1h block TTL set by a proxy does not clash', () => {
  const view = '<chat>\n' + '0+1|summary of a decision\n'.repeat(200) + '</chat>';
  // The view, an instruction, a reply and a follow-up, then Pi's empty settings message.
  const payload = { messages: [
    { role: 'user', content: [{ type: 'text', text: view }, { type: 'text', text: 'compress this' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'line' }] },
    { role: 'user', content: 'again, shorter' },
    { role: 'system', content: [], output_config: { effort: 'low' } },
  ] };
  const output = cachePayload(payload) as { cache_control?: unknown, messages: { content: string | { type: string, cache_control?: unknown }[] }[] };
  assert.equal(output.cache_control, undefined);
  assert.deepEqual(output.messages[2].content, [{ type: 'text', text: 'again, shorter', cache_control: { type: 'ephemeral' } }]);
  // What a proxy that sets 1h on block marks sends on: every mark carries the same TTL, and nothing top-level defaults to 5m.
  const sent = JSON.parse(JSON.stringify(output).replaceAll('{"type":"ephemeral"}', '{"type":"ephemeral","ttl":"1h"}'));
  assert.ok(!('cache_control' in sent));
  assert.ok((JSON.stringify(sent).match(/cache_control/g) ?? []).length <= 4);
  const thinkingLast = cachePayload({ messages: [
    { role: 'user', content: [{ type: 'text', text: view }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'thinking', thinking: 'later' }] },
  ] }) as { messages: { content: { type: string, cache_control?: unknown }[] }[] };
  assert.deepEqual(thinkingLast.messages[1].content.map(b => 'cache_control' in b), [true, false], 'thinking blocks are skipped');
});

test('after a turn adds up to 60 blocks of lines, a mark of the next call still finds one of the last call\'s within 20 blocks', () => {
  const line = '0+1|summary of a decision\n', marks = (lines: number) => {
    const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: '<chat>\n' + line.repeat(lines) + '</chat>' }] }] };
    return (cachePayload(payload) as typeof payload).messages[0].content.flatMap((b, j) => 'cache_control' in b ? [j] : []);
  };
  const found = (added: number) => marks(1000 + added).some(next => marks(1000).some(last => next >= last && next - last <= 20));
  assert.ok([4, 100, 240].every(found), 'a turn that adds 1, 25 or 60 blocks');
  assert.ok(!found(400), 'beyond 60 blocks the last entry is out of reach');
  // With a system prompt, its mark takes the one 40 blocks back: a turn reaches 40 blocks (160 lines), a compaction still 60.
  const withSystem = (lines: number, end = true) => {
    const payload = { system: [{ type: 'text', text: 'system' }], messages: [{ role: 'user', content: [{ type: 'text', text: '<chat>\n' + line.repeat(lines) + '</chat>' }] }] };
    return (cachePayload(payload, { end }) as typeof payload).messages[0].content.flatMap((b, j) => 'cache_control' in b ? [j] : []);
  };
  const reach = (added: number, end = true) => withSystem(1000 + added, end).some(next => withSystem(1000, end).some(last => next >= last && next - last <= 20));
  assert.ok([4, 100, 160].every(added => reach(added)) && !reach(240), 'a turn that adds up to 40 blocks');
  assert.ok(reach(240, false) && !reach(400, false), 'a compaction that adds up to 60 blocks');
});

test('a view written anew still reads the system prompt and tools from the cache: they carry their own mark', () => {
  const payload = (view: string) => ({ system: 'You are OptChat. A long, stable system prompt.', tools: [{ name: 'zoom' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: view }, { type: 'text', text: 'hi' }] }] });
  const output = cachePayload(payload('<chat>\n' + '0+1|a line\n'.repeat(100) + '</chat>')) as { system: { text: string; cache_control?: unknown }[] };
  assert.deepEqual(output.system, [{ type: 'text', text: 'You are OptChat. A long, stable system prompt.', cache_control: { type: 'ephemeral' } }], 'a string prompt becomes one marked block');
  const empty = cachePayload({ system: '', messages: [{ role: 'user', content: [{ type: 'text', text: '<chat>\n' + '0+1|a line\n'.repeat(400) + '</chat>' }] }] });
  assert.equal((JSON.stringify(empty).match(/cache_control/g) ?? []).length, 4, 'with no system prompt the view keeps all three marks');
});

test('the most due pair is the one that ended longest ago in its own line size, so the view merges as Taelin\'s rollback push', () => {
  // Recipe §3.2: at T=10 the old rule, measured from a pair's first message, merged 0-7; push merges 8-9.
  assert.equal(mostDue([{ l: 2, i: 0 }, { l: 2, i: 1 }, { l: 0, i: 8 }, { l: 0, i: 9 }], 10, () => true), 2);
  assert.equal(mostDue([{ l: 2, i: 0 }, { l: 2, i: 1 }, { l: 0, i: 8 }, { l: 0, i: 9 }], 10, part => part.l !== 1), 0, 'a pair whose parent is unbuilt waits');
  type States = { keep: number, state: number, older: States } | null;
  const push = (state: number, states: States): States => !states ? { keep: 0, state, older: null }
    : !states.keep ? { ...states, keep: 1 } : { keep: 0, state, older: push(states.state, states.older) };
  let states: States = null;
  const view: Part[] = [];
  for (let t = 0; t <= 4096; t++) {
    states = push(t, states);
    const starts: number[] = [];
    for (let s = states; s; s = s.older) starts.unshift(s.state);
    view.push({ l: 0, i: t });
    while (view.length > starts.length) {
      const j = mostDue(view, t + 1, () => true), a = view[j];
      view.splice(j, 2, { l: a.l + 1, i: a.i / 2 });
    }
    assert.deepEqual(view.map(start), starts, `step ${t}`);
  }
});

test('the view merges in one batch from its budget down to half, and between batches only grows at its end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-batch-'));
  const memory = new Memory(dir, async () => 's'.repeat(300), () => {}, 6000);
  try {
    let previous: Part[] = [], batches = 0;
    for (let i = 0; i < 120; i++) {
      memory.append('user', `${i} ${'.'.repeat(600)}`);
      await memory.settle(AbortSignal.timeout(5000), 'tree');
      const kept = previous.every((part, j) => memory.view[j].l === part.l && memory.view[j].i === part.i);
      if (!kept) { batches++; assert.ok(memory.size <= 3000, `a batch ends at half the budget, not at ${memory.size}`); }
      else assert.equal(memory.view.length, previous.length + 1, 'otherwise the new message only appends its line');
      assert.ok(memory.size <= 6000);
      previous = [...memory.view];
    }
    assert.ok(batches >= 5 && batches <= 15, `${batches} batches over 120 messages`);
  } finally { await memory.close(); removeDir(dir); }
});

test('the view is saved and loaded as it was, and rebuilt only when the saved one no longer tiles the log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-saved-view-'));
  const compress = async () => 's'.repeat(300), parts = (memory: Memory) => memory.view.map(p => [p.l, p.i]);
  const chatView = () => { const { compaction: _, ...chat } = JSON.parse(readFileSync(join(dir, 'view.json'), 'utf8')); return chat; };
  let memory = new Memory(dir, compress, () => {}, 3000);
  try {
    for (let i = 0; i < 16; i++) { memory.append('user', `${i} ${'.'.repeat(600)}`); await memory.settle(AbortSignal.timeout(5000), 'tree'); }
    const live = parts(memory);
    await memory.close();
    memory = new Memory(dir, compress, () => {}, 3000);
    assert.deepEqual(parts(memory), live, 'the saved view plus a line per later message is the live view');
    await memory.close();
    // A view the fold would not produce, but a valid tiling: loading keeps it rather than refolding.
    const saved = [[3, 0], [2, 2], [0, 12], [0, 13], [0, 14], [0, 15]];
    writeFileSync(join(dir, 'view.json'), JSON.stringify(saved));
    memory = new Memory(dir, compress, () => {}, 3000);
    assert.deepEqual(parts(memory), saved);
    memory.append('user', 'one more');
    assert.deepEqual(parts(memory), [...saved, [0, 16]]);
    assert.deepEqual(chatView(), { parts: saved, merging: false }, 'a line added without a merge is not saved');
    await memory.close();
    const warnings: string[] = [];
    for (const invalid of [[[0, 0], [0, 2]], { version: 99 }, { parts: saved, merging: 'unknown' }]) {
      warnings.length = 0;
      writeFileSync(join(dir, 'view.json'), JSON.stringify(invalid));
      memory = new Memory(dir, compress, text => warnings.push(text), 3000);
      assert.match(warnings.join('\n'), /Rebuilt the memory view/);
      assert.equal(start(memory.view[0]), 0); assert.equal(end(memory.view.at(-1)!), 17);
      assert.deepEqual(chatView(), { parts: parts(memory), merging: false });
      await memory.close();
    }
  } finally { await memory.close(); removeDir(dir); }
});

test('a reopened memory gives compactions the same views as one that never closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-compaction-view-'));
  // Reopened before the chat's view merges, where replaying the log with every line built folds differently than it grew,
  // and after, where the compactions' view used to be refolded from the chat's.
  const run = async (name: string, reopenAt: number[] = []) => {
    const contexts: string[] = [];
    const compress = async ({ context }: Compression) => { contexts.push(context); return 's'.repeat(300); };
    let memory = new Memory(join(dir, name), compress, () => {}, 16000);
    for (let i = 0; i < 70; i++) {
      if (reopenAt.includes(i)) {
        assert.equal(memory.view.some(p => p.l > 0), i > 50, 'the chat\'s view has merged by the second reopen, not the first');
        await memory.close(); memory = new Memory(join(dir, name), compress, () => {}, 16000);
      }
      memory.append('user', `${i} ${'.'.repeat(600)}`); await memory.settle(AbortSignal.timeout(5000), 'tree');
    }
    await memory.close();
    return contexts;
  };
  try { assert.deepEqual(await run('reopened', [30, 62]), await run('live')); }
  finally { removeDir(dir); }
});

test('a process killed mid-batch resumes the chat view to the same lines as an uninterrupted run', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-resume-'));
  const script = `
    import { Memory } from ${JSON.stringify(new URL('../src/memory.ts', import.meta.url).href)};
    let resume;
    const paused = new Promise(resolve => { resume = resolve; });
    process.on('message', () => resume());
    const memory = new Memory(process.argv[1], async ({ part }) => {
      if (part.l === 1 && part.i === 1) {
        setImmediate(() => process.send({ view: memory.view, size: memory.size }));
        await paused;
      }
      return 's'.repeat(300);
    }, () => {}, 1000);
    for (let i = 0; i < 4; i++) memory.append('user', 'x'.repeat(294));
    await memory.settle(undefined, 'tree');
    process.send(memory.view);
    await memory.close();
    process.disconnect();
  `;
  const launch = (name: string) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, join(dir, name)], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    return { child, stopped: once(child, 'exit'), paused: once(child, 'message', { signal: AbortSignal.timeout(5000) }) };
  };
  const uninterrupted = launch('live'), interrupted = launch('killed');
  let reopened: Memory | undefined;
  try {
    for (const [state] of await Promise.all([uninterrupted.paused, interrupted.paused])) {
      assert.deepEqual(state.view, [{ l: 1, i: 0 }, { l: 0, i: 2 }, { l: 0, i: 3 }]);
      assert.ok(state.size > 500 && state.size < 1000, 'the batch is below the trigger but above its target');
    }
    interrupted.child.kill('SIGKILL'); await interrupted.stopped;
    const finished = once(uninterrupted.child, 'message', { signal: AbortSignal.timeout(5000) });
    uninterrupted.child.send('resume');
    const [expected] = await finished;
    await uninterrupted.stopped;
    reopened = new Memory(join(dir, 'killed'), async () => 's'.repeat(300), () => {}, 1000);
    await reopened.settle(AbortSignal.timeout(5000), 'tree');
    assert.deepEqual(reopened.view, expected);
    assert.deepEqual(reopened.view, [{ l: 2, i: 0 }]);
    assert.ok(reopened.size <= reopened.budget / 2);
  } finally {
    for (const { child } of [uninterrupted, interrupted]) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all([uninterrupted.stopped, interrupted.stopped]);
    await reopened?.close(); removeDir(dir);
  }
});

test('compactions get their own view, a quarter of the budget at most, that ends at the node and between its batches only grows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-context-'));
  const leaves: (Compression & { view: Part[] })[] = [];
  const memory: Memory = new Memory(dir, async input => { if (!input.part.l) leaves.push({ ...input, view: [...memory.view] }); return 's'.repeat(300); }, () => {}, 32000);
  try {
    for (let i = 0; i < 400; i++) { memory.append('user', `${i} ${'.'.repeat(600)}`); await memory.settle(AbortSignal.timeout(5000), 'tree'); }
    let rewrites = 0, previous = '', total = 0, chatBatches = 0;
    for (const [k, { context, part, view }] of leaves.entries()) {
      const lines = context.slice('<chat>\n'.length, -'\n</chat>'.length).split('\n').filter(Boolean);
      assert.ok(lines.every(line => /^\d+\+\d+\|s+$/.test(line)), 'built lines only, under their id+n| heads');
      if (lines.length) assert.equal(lines.reduce((n, line) => n + Number(line.split(/[+|]/)[1]), 0), part.i, 'the lines tile the chat up to the message');
      for (const line of lines) {
        const [id, n] = line.split(/[+|]/).map(Number);
        assert.ok(view.some(p => start(p) === id && 2 ** p.l <= n), `${id}+${n} is the chat's view merged further`);
      }
      // A batch that waits on a merge still being built can leave it a line or two over.
      const size = bytes(context);
      assert.ok(size <= 8000 + 600, `at most a quarter of the budget, not ${size}`);
      if (part.i > 100) total += size;
      if (k && view.length < leaves[k - 1].view.length) { chatBatches++; assert.ok(size <= 4000 + 600, `a batch of the chat's view merges it down to an eighth, not ${size}`); }
      if (!context.startsWith(previous)) rewrites++;
      previous = context.slice(0, -'</chat>'.length);
    }
    assert.ok(memory.view.length > previous.split('\n').length, 'coarser than the chat\'s view');
    assert.ok(chatBatches >= 2, `${chatBatches} batches of the chat's view`);
    const mean = total / leaves.filter(c => c.part.i > 100).length;
    assert.ok(mean > 4000 && mean < 8000, `between an eighth and a quarter of the budget on average, not ${mean}`);
    // About one batch per 4,000 bytes of new lines (13 messages here), plus one per batch of the chat's view.
    assert.ok(rewrites >= 20 && rewrites <= 45, `${rewrites} rewrites over ${leaves.length} compactions`);
  } finally { await memory.close(); removeDir(dir); }
});

test('a message\'s node starts once fewer than 8 lines before it are unbuilt, so 8 run at once on one shared view', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-ahead-'));
  const calls: { input: Compression; release: () => void }[] = [];
  const memory = new Memory(dir, input => new Promise(resolve => calls.push({ input, release: () => resolve('s'.repeat(300)) })), () => {}, 128000, 8);
  try {
    memory.append('user', `old ${'.'.repeat(600)}`); await new Promise(resolve => setTimeout(resolve, 20)); calls[0].release(); await memory.settle(AbortSignal.timeout(5000), 'tree');
    for (let i = 1; i <= 12; i++) memory.append('user', `${i} ${'.'.repeat(600)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(calls.slice(1).map(c => c.input.part.i), [1, 2, 3, 4, 5, 6, 7, 8]);
    const views = calls.slice(1).map(c => c.input.context.replace(/\n<\/chat>$/, ''));
    assert.ok(views.every((view, k) => !k || view.startsWith(views[k - 1])), 'each view extends the one before, so they share a cached prefix');
    calls[1].release();
    await new Promise(resolve => setTimeout(resolve, 20));
    // The free worker goes to the merge of messages 0 and 1, which ends earlier in the chat than message 9 (#194).
    assert.deepEqual(calls.slice(9).map(c => c.input.part), [{ l: 1, i: 0 }]);
    calls[9].release();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(calls.slice(10).map(c => c.input.part), [{ l: 0, i: 9 }]);
    calls.forEach(c => c.release());
  } finally { calls.forEach(c => c.release()); await memory.close(); removeDir(dir); }
});

test('a summary sees the built lines after one still being built, such as an echo\'s own tool call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-gaps-'));
  const calls: { input: Compression; release: () => void }[] = [];
  const memory = new Memory(dir, input => new Promise(resolve => calls.push({ input, release: () => resolve('s'.repeat(300)) })), () => {});
  try {
    memory.append('talk', `reply ${'.'.repeat(600)}`);
    memory.append('tool', 'read src/memory.ts');
    memory.append('echo', `contents ${'.'.repeat(600)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
    const echo = calls.find(c => c.input.part.i === 2)!.input.context;
    assert.match(echo, /^0\+1\|\(not summarized yet: zoom it\)$/m);
    assert.match(echo, /^1\+1\|tool: read src\/memory\.ts$/m);
  } finally { calls.forEach(c => c.release()); await memory.close(); removeDir(dir); }
});

test('a view that cannot be saved only warns, since the log stays authoritative', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-unsaved-view-')), warnings: string[] = [];
  mkdirSync(join(dir, 'view.json'), { recursive: true });
  const memory = new Memory(dir, async () => 's'.repeat(300), text => warnings.push(text), 3000);
  try {
    for (let i = 0; i < 16; i++) { memory.append('user', `${i} ${'.'.repeat(600)}`); await memory.settle(AbortSignal.timeout(5000), 'tree'); }
    assert.equal(memory.root.length, 16);
    assert.ok(memory.view.some(p => p.l > 0), 'the view merged');
    assert.match(warnings.join('\n'), /Could not save the memory view/);
    assert.equal(memory.lastError, undefined);
  } finally { await memory.close(); removeDir(dir); }
});

test('next turn excludes old conversation; current tool loop and reasoning remain verbatim', async () => {
  const system: SystemMessage = { role: 'system', content: 'old system', timestamp: 0 };
  const old: UserMessage = { role: 'user', content: 'OLD FULL CONVERSATION', timestamp: 1 };
  const current: UserMessage = { role: 'user', content: 'new question', timestamp: 2 };
  const assistant: AssistantMessage = { role: 'assistant', content: [{ type: 'thinking', thinking: 'private thoughts', thinkingSignature: 'signed' }, { type: 'text', text: 'visible reply' }],
    api: 'anthropic-messages', provider: 'anthropic', model: 'fixture', stopReason: 'stop', timestamp: 3,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const projected = buildContext([system, old, current, assistant], [current, assistant], '<chat>\n0+1|old summary\n</chat>', 'new system');
  assert.ok(!JSON.stringify(projected).includes('OLD FULL CONVERSATION'));
  assert.equal(projected[2], assistant);
  assert.deepEqual(projected[1].role === 'user' && projected[1].content, [{ type: 'text', text: '<chat>\n0+1|old summary\n</chat>' }, { type: 'text', text: '\n\nnew question' }],
    'the user\'s words start their own paragraph, since OpenAI joins text blocks with nothing between them');
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-')); const memory = new Memory(dir, async () => 'summary');
  try { logMessage(memory, assistant); assert.equal(memory.root.length, 1); assert.equal(memory.root[0].text, 'visible reply'); }
  finally { await memory.close(); removeDir(dir); }
});

test('tool images survive active-context truncation while text is bounded', () => {
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'example-base64' };
  const message: ToolResultMessage = { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', isError: false, timestamp: 1,
    content: [{ type: 'text', text: 'x'.repeat(40_000) }, image] };
  const bounded = boundedMessage(message);
  assert.equal(bounded.role, 'toolResult');
  if (bounded.role !== 'toolResult') throw new Error('unexpected role');
  assert.ok(bounded.content.includes(image));
  assert.ok(bounded.content.filter(c => c.type === 'text').reduce((n, c) => n + c.text.length, 0) <= CAP);
});

test('crash recovery saves unconsumed inputs once, including append-before-ack crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-'));
  const memory = new Memory(dir, async () => 'summary');
  try {
    let inbox = new Inbox(dir);
    inbox.record('queued while the agent was working');
    assert.equal(inbox.claim('unrelated extension message'), undefined);
    const delivered = inbox.record('delivered, but crashed before the journal acknowledgment');
    memory.append('user', 'delivered, but crashed before the journal acknowledgment', new Date().toISOString(), delivered);
    inbox = new Inbox(dir);
    assert.equal(inbox.recover(memory), 1);
    assert.equal(memory.root.length, 2);
    assert.equal(new Inbox(dir).recover(memory), 0);
    assert.equal(memory.root.length, 2);
  } finally { await memory.close(); removeDir(dir); }
});

test('incremental view size and pending count match the rendered view across failures and restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-size-'));
  let failures = 3;
  const compress = async (input: Compression) => {
    if (failures-- > 0) throw new Error('transient');
    return input.source.slice(0, 120 + input.source.length % 200);
  };
  const measured = (memory: Memory) => bytes(memory.render());
  let memory = new Memory(dir, compress, () => {}, 4000, 8, 10);
  try {
    for (let i = 0; i < 120; i++) {
      memory.append(i % 3 ? 'echo' : 'user', `${i} ${'detail '.repeat(i % 7 ? 90 : 2)}`);
      assert.equal(memory.size, measured(memory), `size after append ${i}`);
    }
    await memory.settle(AbortSignal.timeout(5000), 'tree');
    assert.equal(memory.pending, 0);
    assert.equal(memory.size, measured(memory));
    await memory.close();
    memory = new Memory(dir, compress, () => {}, 4000, 8, 10);
    assert.equal(memory.pending, 0);
    assert.equal(memory.size, measured(memory));
  } finally { await memory.close(); removeDir(dir); }
});

test('a node the model refuses or leaves empty keeps the start of its source instead of being retried, and a leaf sends at most SOURCE characters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-refused-'));
  const calls: Compression[] = [], warnings: string[] = [];
  const compress = async (input: Compression) => {
    calls.push(input);
    if (input.source.startsWith('user: refuse')) throw new Refused('The model refused.');
    return input.source.startsWith('user: empty') ? ' ' : 'summary';
  };
  const memory = new Memory(dir, compress, text => warnings.push(text), 4000, 8, 10);
  try {
    memory.append('user', `refuse\n${'x'.repeat(600)}`);
    memory.append('user', `empty ${'y'.repeat(600)}`);
    memory.append('user', 'z'.repeat(3 * SOURCE));
    await memory.settle(AbortSignal.timeout(5000), 'tree');
    assert.equal(memory.node({ l: 0, i: 0 })?.text, `(not summarized: zoom it) user: refuse ${'x'.repeat(NODE - 39)}`);
    assert.match(memory.node({ l: 0, i: 1 })?.text ?? '', /^\(not summarized: zoom it\) user: empty y+$/);
    assert.deepEqual(calls.filter(c => c.part.l === 0).map(c => c.part.i), [0, 1, 2], 'each leaf is asked once');
    assert.ok(calls[2].source.length <= SOURCE);
    assert.ok(memory.node({ l: 1, i: 0 }), 'the refused leaves still merge');
    assert.deepEqual(warnings.map(w => w.split(':')[0]), ['Compactor 0+1', 'Compactor 1+1']);
  } finally { await memory.close(); removeDir(dir); }
});

test('a retry that falls due while the compactor is scheduling still runs', async () => {
  // Each clock reading advances, so a retry can fall due between deciding to skip it and arming its timer.
  const now = Date.now;
  for (const step of [1, 2, 3]) {
    const dir = mkdtempSync(join(tmpdir(), 'oc-due-'));
    let failures = 1, clock = now();
    const memory = new Memory(dir, async ({ source }) => { if (failures-- > 0) throw new Error('transient'); return source.slice(0, 100); }, () => {}, 4000, 8, 10);
    try {
      Date.now = () => (clock += step);
      memory.append('user', 'x'.repeat(600));
      // A ref'd timer keeps the process alive, so a hang fails here instead of draining the event loop.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([memory.settle(undefined, 'tree').then(() => 'settled'),
        new Promise(resolve => { timer = setTimeout(resolve, 1000, 'hung'); })]);
      clearTimeout(timer);
      assert.equal(result, 'settled', `clock step ${step}`);
    } finally { Date.now = now; await memory.close(); removeDir(dir); }
  }
});

// Work counters, not timings: the old code re-measured the whole view on every fit and rescanned every level from 0 on every pump.
function longProfile(count: number) {
  // Written directly: one fsync per append would make the fixture slow. Short entries are their own summaries.
  const dir = mkdtempSync(join(tmpdir(), 'optchat-scale-'));
  mkdirSync(join(dir, 'main')); mkdirSync(join(dir, 'tree'));
  const date = new Date().toISOString(), lines: string[] = [], nodes: string[] = [];
  for (let i = 0; i < count; i++) lines.push(JSON.stringify({ i, kind: 'user', text: `m${i}`, date }));
  for (let l = 0, n = count; n > 0; l++, n = Math.floor(n / 2))
    for (let i = 0; i < n; i++) nodes.push(JSON.stringify({ l, i, text: `summary ${l}:${i}` }));
  writeFileSync(join(dir, 'main', `${localDay()}.jsonl`), lines.join('\n') + '\n');
  writeFileSync(join(dir, 'tree', `${localDay()}.jsonl`), nodes.join('\n') + '\n');
  return dir;
}

test('loading a long profile does not re-measure the whole view for every message', async () => {
  const count = 2048, dir = longProfile(count);
  const get = Map.prototype.get;
  let lookups = 0;
  Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) { lookups++; return get.call(this, key); };
  let memory: Memory | undefined;
  try { memory = new Memory(dir, async () => 'unused', () => {}); }
  finally { Map.prototype.get = get; }
  try {
    assert.equal(memory.view.length, count);
    assert.ok(lookups < 10 * count, `${lookups} lookups to load ${count} messages`);
  } finally { await memory.close(); removeDir(dir); }
});

test('a new message is summarized without rescanning every built node', async () => {
  const count = 2048, dir = longProfile(count);
  // A small budget keeps the view short, as in a real profile, so the tree is far larger than the view.
  const memory = new Memory(dir, async () => 'unused', () => {}, 1000);
  try {
    assert.ok(memory.view.length < 100);
    await memory.settle(AbortSignal.timeout(10000), 'tree'); // the first pump after load finds each level's frontier
    const get = memory.tree.get;
    let lookups = 0;
    memory.tree.get = function (this: typeof memory.tree, key) { lookups++; return get.call(this, key); };
    memory.append('user', 'one more');
    await memory.settle(AbortSignal.timeout(10000), 'tree');
    assert.equal(memory.pending, 0);
    assert.ok(lookups < count / 2, `${lookups} tree lookups for one new message over ${count}`);
  } finally { await memory.close(); removeDir(dir); }
});

test('merges that keep failing are queued, so a new message never scans their level of the tree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-queue-'));
  // Each 300-byte message is its own line, and merging two needs the compactor, which refuses. The budget keeps the view from merging.
  const memory = new Memory(dir, async () => { throw new Error('refused'); }, () => {}, 10_000_000, 8, 60_000);
  const idle = async () => { while (memory.pending || memory.active) await new Promise(resolve => setTimeout(resolve, 5)); };
  try {
    for (let i = 0; i < 200; i++) memory.append('user', `${i} ${'.'.repeat(300)}`);
    await idle();
    const get = memory.tree.get;
    let lookups = 0;
    memory.tree.get = function (this: typeof memory.tree, key) { lookups++; return get.call(this, key); };
    memory.append('user', `one more ${'.'.repeat(300)}`);
    await idle();
    assert.ok(lookups < 100, `${lookups} tree lookups for one new message, with all 100 merges failing`);
  } finally { await memory.close(); removeDir(dir); }
});

test('a message whose node keeps failing is queued, so later messages never scan the leaves after it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-stuck-leaf-'));
  // Message 0 needs the compactor, which refuses it; every later message is its own line and their merges succeed.
  const memory = new Memory(dir, async input => { if (input.part.l === 0) throw new Error('refused'); return 's'.repeat(100); }, () => {}, 10_000_000, 8, 60_000);
  const idle = async () => { while (memory.pending > 1 || memory.active) await new Promise(resolve => setTimeout(resolve, 5)); };
  try {
    memory.append('user', `0 ${'.'.repeat(600)}`);
    for (let i = 1; i < 200; i++) memory.append('user', `${i} ${'.'.repeat(300)}`);
    await idle();
    assert.equal(memory.pending, 1, 'only message 0 is unbuilt');
    const get = memory.tree.get;
    let lookups = 0;
    memory.tree.get = function (this: typeof memory.tree, key) { lookups++; return get.call(this, key); };
    memory.append('user', `one more ${'.'.repeat(300)}`);
    await idle();
    assert.ok(lookups < 100, `${lookups} tree lookups for one new message, with message 0 failing`);
  } finally { await memory.close(); removeDir(dir); }
});

test('an expanded /skill: command claims the input it came from, and only that one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-inbox-'));
  try {
    const inbox = new Inbox(dir);
    const plain = inbox.record('/skill:demox');
    const skill = inbox.record('/skill:demox  go');
    assert.equal(inbox.claimSkill('demo', 'go'), undefined, 'a skill name must match whole');
    assert.equal(inbox.claimSkill('demox', 'other'), undefined, 'arguments must match');
    assert.equal(inbox.claimSkill('demox', 'go'), skill);
    assert.equal(inbox.claimSkill('demox', 'go'), undefined, 'an input is claimed once');
    assert.equal(inbox.claimSkill('demox'), plain);
  } finally { removeDir(dir); }
});

test('rebuilding a leaf that a saved parent already hides does not inflate the view size', async () => {
  // A damaged tree file can lose a leaf while its parent survives; loading then merges the unbuilt leaf away.
  const dir = mkdtempSync(join(tmpdir(), 'optchat-hidden-'));
  mkdirSync(join(dir, 'main')); mkdirSync(join(dir, 'tree'));
  const date = new Date().toISOString();
  const texts = ['x'.repeat(400), 'b', 'c', 'd'];
  writeFileSync(join(dir, 'main', `${localDay()}.jsonl`), texts.map((text, i) => JSON.stringify({ i, kind: 'user', text, date })).join('\n') + '\n');
  const nodes = [{ l: 0, i: 1 }, { l: 0, i: 2 }, { l: 0, i: 3 }, { l: 1, i: 0 }, { l: 1, i: 1 }];
  writeFileSync(join(dir, 'tree', `${localDay()}.jsonl`), nodes.map(n => JSON.stringify({ ...n, text: `summary ${n.l}:${n.i} padded to twenty` })).join('\n') + '\n{damaged\n');
  const measured = (memory: Memory) => bytes(memory.render());
  const memory = new Memory(dir, async () => 'top', () => {}, 80);
  try {
    assert.ok(memory.view.every(p => p.l > 0), 'the unbuilt leaf 0 is hidden by its saved parent');
    assert.equal(memory.pending, 1);
    await memory.settle(AbortSignal.timeout(3000), 'tree');
    assert.equal(memory.pending, 0);
    assert.equal(memory.size, measured(memory));
    assert.ok(memory.size <= 80);
  } finally { await memory.close(); removeDir(dir); }
});

test('a log whose day files sort against the order of the entries still opens, and a broken one does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-order-')), compress = async () => 'summary';
  const home = process.env.TZ;
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-05T17:00:00Z') });
  const opened: Memory[] = [];
  try {
    process.env.TZ = 'Asia/Tokyo';
    let memory = new Memory(dir, compress, () => {}); opened.push(memory);
    memory.append('user', 'a'); memory.append('user', 'b'); await memory.close();
    process.env.TZ = 'America/Sao_Paulo';
    memory = new Memory(dir, compress, () => {}); opened.push(memory);
    memory.append('user', 'c'); await memory.close();
    assert.deepEqual(readdirSync(join(dir, 'main')).sort(), ['2026-10-05.jsonl', '2026-10-06.jsonl']);
    memory = new Memory(dir, compress, () => {}); opened.push(memory);
    assert.deepEqual(memory.root.map(e => e.text), ['a', 'b', 'c']);
    await memory.close();
  } finally {
    mock.timers.reset();
    if (home === undefined) delete process.env.TZ; else process.env.TZ = home;
    await Promise.all(opened.map(m => m.close()));
  }
  const entry = (i: number) => JSON.stringify({ i, kind: 'user', text: `m${i}`, date: new Date().toISOString() }) + '\n';
  try {
    writeFileSync(join(dir, 'main', '2026-10-05.jsonl'), entry(2) + entry(2));
    assert.throws(() => new Memory(dir, compress, () => {}), /noncontiguous/);
    writeFileSync(join(dir, 'main', '2026-10-05.jsonl'), entry(2));
    writeFileSync(join(dir, 'main', '2026-10-06.jsonl'), entry(0) + entry(3));
    assert.throws(() => new Memory(dir, compress, () => {}), /noncontiguous/);
  } finally { removeDir(dir); }
});

test('an append ends an unterminated last line, in every file, and counts the byte it wrote', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-torn-')), file = join(dir, 'log.jsonl');
  try {
    appendJson(file, { n: 1 }); appendFileSync(file, '{"n":');
    const size = appendJson(file, { n: 2 });
    assert.equal(readFileSync(file, 'utf8'), '{"n":1}\n{"n":\n{"n":2}\n');
    assert.equal(size, readFileSync(file).length);
    assert.equal(appendJson(file, { n: 3 }, size), readFileSync(file).length);
  } finally { removeDir(dir); }
});

test('an append cut short leaves the file as it was, so the next append is not refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-short-')), file = join(dir, 'log.jsonl');
  const write = fs.writeSync;
  try {
    const size = appendJson(file, { n: 1 });
    mock.method(fs, 'writeSync', (fd: number, data: Buffer) => write(fd, data, 0, 3));
    syncBuiltinESMExports();
    assert.throws(() => appendJson(file, { n: 2 }, size), /Incomplete write/);
    mock.restoreAll(); syncBuiltinESMExports();
    assert.equal(readFileSync(file, 'utf8'), '{"n":1}\n');
    assert.equal(appendJson(file, { n: 3 }, size), readFileSync(file).length);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); removeDir(dir); }
});

test('a torn tail that Memory loaded is repaired by its next append without tripping the write guard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-torn-')), compress = async () => 'summary', warnings: string[] = [];
  let memory = new Memory(dir, compress, () => {});
  memory.append('user', 'first'); await memory.close();
  const file = join(dir, 'main', `${localDay()}.jsonl`);
  appendFileSync(file, '{"i":1,"kind":"user","te');
  const torn = readFileSync(file, 'utf8');
  memory = new Memory(dir, compress, text => warnings.push(text));
  try {
    assert.equal(readFileSync(file, 'utf8'), torn, 'opening a profile writes nothing');
    memory.append('user', 'second'); memory.append('user', 'third');
    assert.equal(warnings.length, 1);
  } finally { await memory.close(); }
  memory = new Memory(dir, compress, () => {});
  try { assert.deepEqual(memory.root.map(e => e.text), ['first', 'second', 'third']); }
  finally { await memory.close(); removeDir(dir); }
});

test('a torn tail that another process wrote is refused, not repaired', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-torn-')), memory = new Memory(dir, async () => 'summary', () => {});
  try {
    memory.append('user', 'first');
    const file = join(dir, 'main', `${localDay()}.jsonl`);
    appendFileSync(file, '{"i":1,"kind":"user","te');
    const before = readFileSync(file, 'utf8');
    assert.throws(() => memory.append('user', 'second'), /Another process wrote .*nothing was written/);
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally { await memory.close(); removeDir(dir); }
});

const wellFormed = (text: string) => Buffer.from(text).toString() === text;
const pieces = (out: string) => {
  const notice = out.match(/\n\[(\d+) characters omitted; head and tail retained\]\n/)!;
  return { claimed: Number(notice[1]), head: out.slice(0, notice.index), tail: out.slice(notice.index! + notice[0].length) };
};

test('cap states exactly how many characters it omitted and stays within the limit', () => {
  assert.equal(cap('x'.repeat(CAP)), 'x'.repeat(CAP));
  for (const text of ['x'.repeat(CAP + 1), 'x'.repeat(CAP + 49), 'x'.repeat(250_000)]) {
    const out = cap(text), { claimed, head, tail } = pieces(out);
    assert.ok(out.length <= CAP, `${out.length} units`);
    assert.ok(text.startsWith(head) && text.endsWith(tail));
    assert.equal(claimed, text.length - head.length - tail.length);
  }
});

test('cap never cuts a surrogate pair in half', () => {
  const emoji = '\u{1F600}'.repeat(CAP);
  for (const text of ['a' + emoji, emoji, 'ab' + emoji, emoji + 'a']) {
    const out = cap(text), { claimed, head, tail } = pieces(out);
    assert.ok(wellFormed(out), `lone surrogate in the cap of a ${text.length} unit text`);
    assert.ok(out.length <= CAP && text.startsWith(head) && text.endsWith(tail));
    assert.equal(claimed, text.length - head.length - tail.length);
  }
});

test('labels and framing trigger a batch even when the line bodies fit the budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-budget-'));
  const memory = new Memory(dir, async () => 'résumé', () => {}, 1000);
  try {
    assert.equal(memory.size, bytes(memory.render()), 'empty framing');
    for (let i = 0; i < 4; i++) {
      memory.append('user', 'é'.repeat(119) + '\nx');
      assert.equal(memory.size, bytes(memory.render()), 'placeholder labels and newlines');
      await memory.settle(AbortSignal.timeout(2000), 'tree');
      assert.equal(memory.size, bytes(memory.render()), 'built and merged lines');
      if (i < 3) assert.equal(memory.view.length, i + 1);
    }
    // Four 246-byte bodies fit in 1,000 bytes; their full rendered lines take 1,018.
    assert.deepEqual(memory.view, [{ l: 2, i: 0 }]);
    assert.ok(memory.size <= memory.budget / 2);
  } finally { await memory.close(); removeDir(dir); }
});

test('view size counts the flattened text that render emits, for new and reloaded summaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-flat-'));
  const measured = (memory: Memory) => bytes(memory.render());
  let memory = new Memory(dir, async () => 'x');
  try {
    memory.append('user', 'a\r\n\r\n\r\nb\n\n\nc');
    assert.equal(memory.size, measured(memory), 'built from the entry');
    await memory.settle(AbortSignal.timeout(2000), 'tree');
    assert.equal(memory.size, measured(memory));
    await memory.close();
    memory = new Memory(dir, async () => 'x');
    assert.equal(memory.size, measured(memory), 'loaded from the tree');
  } finally { await memory.close(); removeDir(dir); }
});

test("a tool result's summary sees the raw call it answers, paired in order through parallel calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-test-'));
  const calls: Compression[] = [];
  const memory = new Memory(dir, async input => { calls.push(input); return 'summary'; }, () => {});
  const long = (s: string) => `${s} ${'x'.repeat(600)}`;
  try {
    memory.append('user', long('please read two files'));
    memory.append('tool', long('read {"path":"a.ts"}'));
    memory.append('tool', long('bash {"command":"ls"}'));
    memory.append('echo', long('read: contents of a'));
    memory.append('echo', long('bash: listing'));
    memory.append('tool', long('edit {"path":"b.ts"}'));
    memory.append('echo', long('Agent error: overloaded'));
    await memory.settle(AbortSignal.timeout(5000), 'tree');
    const leaf = (i: number) => calls.find(c => c.part.l === 0 && c.part.i === i)!;
    assert.deepEqual([0, 1, 2, 5].map(i => leaf(i).call), [undefined, undefined, undefined, undefined]);
    assert.equal(leaf(6).call, undefined);
    assert.deepEqual([leaf(3).call?.i, leaf(4).call?.i], [1, 2]);
    const task = compaction(leaf(4));
    assert.match(task, /message 4 answers \(message 2,[^]*<call>\ntool: bash \{"command":"ls"\}[^]*<\/call>\n<input>\necho: bash: listing/);
    assert.doesNotMatch(compaction(leaf(1)), /<call>/);
    assert.doesNotMatch(leaf(4).context, /tool: bash/);
  } finally { await memory.close(); removeDir(dir); }
});
