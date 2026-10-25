// A port of UniiChat's cache.test.ts (Victor Taelin, Apache-2.0, https://github.com/VictorTaelin/UniiChat): a chat replayed through
// the real Memory, compactor and turn context, and pi-ai's Anthropic client, against a fake Anthropic that caches by its rules. An
// entry is written only at a mark, keyed by the whole prefix up to it; a mark reads the latest live entry at most LOOK blocks before
// it; an entry serves only once its writer's response has begun. The 5-minute TTL is left out: the replay runs in seconds, and the
// compactor's gate gives up its warm state (WARM_MS) before Anthropic would. Unlike Unii's, every eighth turn runs 50-60 tool steps,
// over 25 blocks of new view lines, so a single view mark would miss on the next turn (#96). Subagents aren't replayed: parallel
// siblings each write the view, with no gate (#196).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { convertToLlm, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { cachePayload } from '../src/cache.ts';
import { createCompressor } from '../src/compactor.ts';
import { Memory } from '../src/memory.ts';
import { COMPACT, MASTER } from '../src/prompts.ts';
import type { Saved, Store } from '../src/store.ts';
import { buildContext, logMessage, textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';

const LOOK = 20;
/** OPTCHAT_CACHE_REPORT=1 sends a system prompt about the size of Pi's (with AGENTS.md, skills and tool docs) and prints what each
 * kind of request read and wrote, for comparing cache changes; see docs/recipe-differences.md. */
const REPORT = !!process.env.OPTCHAT_CACHE_REPORT;
const SYSTEM = REPORT ? `${MASTER}\n\n${'Tool and project notes. '.repeat(1500)}` : undefined;
type Block = Record<string, unknown>;
type Body = { system?: Block[]; tools?: unknown; messages: { role: string; content: string | Block[] }[] };
/** Characters a kind of request read from the cache; could have read with a mark on every block, the longest prefix an earlier
 * request sent; and sent, less a compaction's own task, as Unii counts it. */
type Use = { read: number; reusable: number; sent: number; n: number };

let seed = 1;
const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const text = (kind: string, min: number, max: number) => `${kind} ${createHash('sha256').update(String(rand())).digest('base64')
  .repeat(Math.ceil(max / 44)).slice(0, min + Math.floor(rand() * (max - min)))}`;
const tick = () => new Promise(resolve => setImmediate(resolve));

function fakeAnthropic() {
  const cache = new Map<string, { ready: boolean }>(), sent = new Set<string>(), uses: Record<string, Use> = {}, refused: string[] = [];
  let taskMarks = 0;
  let kind = 'turn';
  const account = (body: Body) => {
    const compaction = body.system?.[0]?.text === COMPACT;
    const blocks: Block[] = [...body.system ?? [], ...body.messages.flatMap((m): Block[] => typeof m.content === 'string' ? [{ text: m.content }] : m.content.map(b => ({ ...b, role: m.role })))];
    const marks = blocks.flatMap((b, k) => 'cache_control' in b ? [k] : []);
    // A compaction's task is never sent again, so a mark on it would only write it at 1.25× (#197).
    if (compaction && marks.at(-1) === blocks.length - 1) taskMarks++;
    // Noted rather than thrown: a compactor error would only be retried, so the test asserts these at its end.
    if (marks.length > 4 || 'cache_control' in body) refused.push(`${marks.length} block marks${'cache_control' in body ? ' and a top-level one' : ''}`);
    const keys: string[] = [], ends: number[] = [];
    for (const { cache_control: _, ...block } of blocks) {
      const json = JSON.stringify(block);
      keys.push(createHash('sha256').update((keys.at(-1) ?? JSON.stringify(body.tools ?? null)) + json).digest('hex'));
      ends.push((ends.at(-1) ?? 0) + json.length);
    }
    let hit = -1;
    for (const m of marks) for (let k = m; k > m - LOOK && k >= 0; k--) if (cache.get(keys[k])?.ready) { hit = Math.max(hit, k); break; }
    const reusable = keys.findLastIndex(k => sent.has(k));
    for (const k of keys) sent.add(k);
    const written = marks.filter(m => m > hit && !cache.has(keys[m])).map(m => { const entry = { ready: false }; cache.set(keys[m], entry); return entry; });
    const use = (uses[compaction ? 'compaction' : kind] ??= { read: 0, reusable: 0, sent: 0, n: 0 });
    use.read += hit < 0 ? 0 : ends[hit]; use.reusable += reusable < 0 ? 0 : ends[reusable]; use.sent += ends.at(compaction ? -2 : -1)!; use.n++;
    return { written, compaction };
  };
  const sse = (events: object[]) => new TextEncoder().encode(events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  const fetch = async (_url: unknown, init?: RequestInit) => {
    const { written, compaction } = account(JSON.parse(String(init?.body)));
    const line = compaction ? text('summary', 250, 400) : 'ok';
    return new Response(new ReadableStream({
      async start(out) {
        await tick();
        out.enqueue(sse([{ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]));
        for (const entry of written) entry.ready = true;
        await tick();
        out.enqueue(sse([{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: line } }, { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }]));
        out.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };
  /** Anthropic's cache expired: nothing earlier is live, and the next requests start counting afresh. */
  const expire = () => { cache.clear(); sent.clear(); for (const key of Object.keys(uses)) delete uses[key]; };
  return { uses, refused, fetch, expire, as: (next: string) => { kind = next; }, taskMarks: () => taskMarks };
}

/** The memory in RAM: persistence isn't under test, and a file store's fsyncs would take most of the run. */
function ramStore(): Store {
  const saved: Saved = { entries: [], tree: [] };
  return { load: () => structuredClone(saved), append: e => void saved.entries.push(e), appendNode: n => void saved.tree.push(n),
    saveView: view => void (saved.view = view), putImage: () => undefined, image: () => undefined };
}

test('turns and compactions read nearly all their input from the cache, also after a long tool run and a cold restart', { timeout: 60_000 }, async t => {
  const fake = fakeAnthropic();
  t.mock.method(globalThis, 'fetch', fake.fetch);
  const dir = mkdtempSync(join(tmpdir(), 'optchat-cache-replay-'));
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fake', { baseUrl: 'https://fake.invalid', apiKey: 'synthetic', api: 'anthropic-messages',
    models: [{ id: 'claude', name: 'Fake', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1000 }] });
  const registry = new ModelRegistry(runtime), model = registry.find('fake', 'claude')!, store = ramStore();
  const open = async () => new Memory({ directory: dir, store, saved: await store.load() },
    createCompressor(registry, () => ({ provider: 'fake', model: 'claude', thinking: 'off' })), () => {});
  const assistant = (content: Extract<AgentMessage, { role: 'assistant' }>['content']): AgentMessage =>
    ({ role: 'assistant', content, api: model.api, provider: 'fake', model: 'claude', stopReason: 'stop', usage: emptyUsage(), timestamp: Date.now() });
  let memory = await open(), previous: AgentMessage[] = [], long = false;
  // Whatever fails, the open memory's compactions and retry timers stop with the test.
  t.after(() => memory.close());
  // As index.ts runs a turn: the view is taken once, when every line of it is built; each step logs into memory as it lands.
  for (let turn = 0; turn < 80; turn++) {
    const steps = turn % 8 === 7 ? 50 + Math.floor(rand() * 11) : Math.floor(rand() * 7);
    await memory.settle();
    const task: Extract<AgentMessage, { role: 'user' }> = { role: 'user', content: [{ type: 'text', text: text('user', 40, 1500) }], timestamp: Date.now() };
    const view = memory.render(), run: AgentMessage[] = [task];
    logMessage(memory, task);
    for (let step = 0; ; step++) {
      fake.as(step === 0 && long ? 'turn after a long one' : 'turn');
      const reply = await registry.streamSimple(model, { ...SYSTEM && { systemPrompt: SYSTEM }, messages: convertToLlm(buildContext([], run, view, MASTER, previous)) }, { onPayload: payload => cachePayload(payload) }).result();
      assert.equal(reply.stopReason, 'stop', reply.errorMessage);
      const next = step < steps ? assistant([{ type: 'toolCall', id: `t${step}`, name: 'zoom', arguments: { query: text('tool', 20, 400) } }])
        : assistant([{ type: 'text', text: text('talk', 100, 2500) }]);
      run.push(next); logMessage(memory, next);
      if (step === steps) break;
      const result: AgentMessage = { role: 'toolResult', toolCallId: `t${step}`, toolName: 'zoom', content: [{ type: 'text', text: text('echo', 40, 3000) }], isError: false, timestamp: Date.now() };
      run.push(result); logMessage(memory, result);
    }
    // The previous exchange as previousExchange() keeps it: the request as text and the final answer, here always under 16 KB.
    previous = [{ ...task, content: textContent(task.content) }, run.at(-1)!];
    long = steps >= 50;
  }
  await memory.settle(undefined, 'tree');
  await memory.close();
  const replay = structuredClone(fake.uses);
  // A restart after the cache expired: a fresh gate, a cold compactions' view, and a backlog of tool results, 8 summaries at once.
  fake.expire();
  memory = await open();
  for (let k = 0; k < 64; k++) memory.append('echo', text('echo', 1000, 3000));
  await memory.settle(undefined, 'tree');
  await memory.close();
  // Measured: turns read 100% of what they could (98.1% of all they sent), the turn after a long one 97.9% (37.3%: its view has the
  // long turn's lines new), compactions 98.4% (95.3%), the cold backlog 98.4% (95.2%). Compactions miss where a line inside their
  // view changes or a view ends before a sibling's. One view mark reads 0% after a long turn; no gate, 89% in the backlog; messages
  // built before merges (#194), 73%.
  if (REPORT) {
    const rows = [...Object.entries(replay), ['cold restart', fake.uses.compaction] as const];
    console.log(JSON.stringify(Object.fromEntries(rows.map(([kind, use]) => [kind, { requests: use.n, sent: use.sent, read: use.read, written: use.sent - use.read }]))));
  }
  assert.deepEqual(fake.refused, [], 'Anthropic takes at most 4 marks, and no top-level one beside block marks');
  assert.equal(fake.taskMarks(), 0, 'no compaction marks its task');
  for (const [kind, use] of [...Object.entries(replay), ['cold restart', fake.uses.compaction] as const])
    assert.ok(use.read >= 0.95 * use.reusable, `${kind}: read ${use.read} of ${use.reusable} reusable characters (${use.sent} sent)`);
});
