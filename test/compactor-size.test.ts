import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createCompressor } from '../src/compactor.ts';
import { compaction } from '../src/prompts.ts';
import { createHandoffSummarizer } from '../src/handoff.ts';
import type { RunInfo } from '../src/runs.ts';
import { bytes, NODE } from '../src/memory.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

let sentReasoning: string | undefined;
let sentStep = '';
let sentRetry = '';
let sentMessages = 0;
/** A fake model whose first reply is `first` bytes long and whose retries fit. */
async function attempts(first: number, { source = 'user: ' + 'a long message '.repeat(70), merge = false, accepted, first: text = 'x', firstEnd, ends = 1 }:
  { source?: string; merge?: boolean; accepted?: number; first?: string; firstEnd?: 'length' | 'toolUse'; ends?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-size-'));
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  let calls = 0;
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    // Like Sonnet 5.5: thinking can't be turned off.
    models: [{ id: 'compactor', name: 'Synthetic compactor', reasoning: true, thinkingLevelMap: { off: null, minimal: null }, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      sentReasoning = options?.reasoning;
      const request = context.messages.find(m => m.role === 'user')?.content;
      sentStep = Array.isArray(request) ? request.map(c => c.type === 'text' ? c.text : '').at(-1) ?? '' : request ?? '';
      sentMessages = context.messages.filter(m => m.role !== 'system').length;
      sentRetry = Array.isArray(request) && request.length > 2 && request[2].type === 'text' ? request[2].text : '';
      if (Array.isArray(request) && request.length > 2) sentStep = request.map(c => c.type === 'text' ? c.text : '')[1];
      const stream = createAssistantMessageEventStream();
      const end = calls < ends ? firstEnd ?? 'stop' : 'stop';
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: calls++ ? 'x'.repeat(400) : text.repeat(first) },
        ...end === 'toolUse' ? [{ type: 'toolCall' as const, id: 'call-1', name: 'zoom', arguments: { id: 0 } }] : []], api: model.api,
        provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: end, usage: emptyUsage() };
      queueMicrotask(() => { stream.push({ type: 'done', reason: end, message }); stream.end(); });
      return stream;
    },
  });
  try {
    const compress = createCompressor(new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'compactor', thinking: 'off' }), undefined,
      accepted === undefined ? undefined : () => accepted);
    const line = await compress({ context: '<chat>\n</chat>', source, part: merge ? { l: 1, i: 0 } : { l: 0, i: 0 } }, new AbortController().signal);
    return { calls, bytes: line.length };
  } finally { removeDir(dir); }
}

test('a summary up to 640 bytes is kept; one over 640 is retried', async () => {
  assert.deepEqual(await attempts(640), { calls: 1, bytes: 640 });
  assert.deepEqual(await attempts(641), { calls: 2, bytes: 400 });
});

test('a reply cut off at the token limit, or one that calls a tool, is no summary: it is asked again', async () => {
  assert.deepEqual(await attempts(100, { firstEnd: 'length' }), { calls: 2, bytes: 400 }, 'a short line cut off by stopReason length');
  assert.deepEqual(await attempts(100, { firstEnd: 'toolUse' }), { calls: 2, bytes: 400 }, 'a short line beside a tool call');
  await assert.rejects(attempts(100, { firstEnd: 'length', ends: 5 }), /^Error: Compactor returned no whole line in 5 tries\.$/);
});

test('the profile\'s summary size tolerance decides when a line is retried', async () => {
  assert.deepEqual(await attempts(513, { accepted: 512 }), { calls: 2, bytes: 400 }, '512 is Victor\'s strict rule');
  assert.deepEqual(await attempts(700, { accepted: 700 }), { calls: 1, bytes: 700 });
});

test('a thinking level the model can\'t take is clamped like Pi does, not sent as none (which Sonnet 5.5 runs at high effort)', async () => {
  await attempts(400);
  assert.equal(sentReasoning, 'low', 'the fixture asks for "off"');
});

test('a merge that is not smaller than the two lines it replaces is retried', async () => {
  const children = ['a'.repeat(280), 'b'.repeat(280)].join('\n'); // 561 bytes
  assert.deepEqual(await attempts(590, { source: children, merge: true }), { calls: 2, bytes: 400 });
  assert.deepEqual(await attempts(590, { source: 'c'.repeat(1000), merge: true }), { calls: 1, bytes: 590 });
});

test('the task is the recipe\'s, with a 512-dash ruler for the size, and a merge names its lines and messages', () => {
  const ruler = '-'.repeat(NODE);
  assert.equal(compaction({ source: 'user: hi', part: { l: 0, i: 40 } }),
    `Compaction: compress message 40 into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n${ruler}\n<input>\nuser: hi\n</input>`);
  assert.equal(compaction({ source: 'a\nb', part: { l: 3, i: 5 } }),
    `Compaction: merge lines 40+4 and 44+4, adjacent, into one line of at most\n512 bytes (about 70 words), the length of this ruler:\n${ruler}\n`
    + `<chat> may hold their messages, 40 to 47, in more detail: take details\nof them from there too.\n<input>\na\nb\n</input>`);
});

test('a line over the limit is sent back with the recipe\'s "Too long" cut, and an id+n| head copied from the view is dropped', async () => {
  const source = 'user: ' + 'a long message '.repeat(70);
  assert.deepEqual(await attempts(700, { source }), { calls: 2, bytes: 400 });
  assert.ok(sentStep.startsWith('\n\nCompaction:'), 'the task starts its own paragraph: OpenAI joins text blocks with nothing between them');
  assert.ok(sentStep.endsWith(`<input>\n${source}\n</input>`));
  assert.equal(sentMessages, 1, 'a retry is one user message: the earlier reply and its thinking are not sent again');
  assert.ok(sentStep.endsWith(`<input>\n${source}\n</input>`), 'the retry keeps the task as it was');
  assert.equal(sentRetry, `\n\nToo long: your line is 700 bytes, over the 512-byte limit. Write\nthe whole line again for the same <input>, cutting just enough of the\nleast valuable items to fit before this cut:\n${'x'.repeat(NODE)}| ← LIMIT`);
  assert.deepEqual(await attempts(1, { first: '12+4|user: kept' }), { calls: 1, bytes: 'user: kept'.length });
});

test('handoffs clamp the compactor\'s thinking level too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-size-'));
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  let sent: string | undefined;
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'compactor', name: 'Synthetic compactor', reasoning: true, thinkingLevelMap: { off: null, minimal: null }, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, _context, options) {
      sent = options?.reasoning;
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Handoff.' }], api: model.api,
        provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  try {
    const summarize = createHandoffSummarizer(new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'compactor', thinking: 'off' }), () => {});
    const run: RunInfo = { id: 'a1', task: 'Task', cwd: dir, model: 'optchat-test/compactor', thinking: 'off', parentSession: 'main', started: 0, depth: 1, state: 'completed', guidance: [] };
    assert.equal(await summarize(run, []), 'Handoff.');
    assert.equal(sent, 'low', 'the fixture asks for "off"');
  } finally { removeDir(dir); }
});
