import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createCompressor } from '../src/compactor.ts';
import { Refused } from '../src/memory.ts';
import { emptyUsage } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';

/** A fake Anthropic model whose calls answer and finish only when the test says so. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-compactor-'));
  const calls: { source: string; answer: () => void; finish: () => void; fail: (error?: string, stop?: string) => void }[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'anthropic-messages',
    models: [{ id: 'compactor', name: 'Synthetic compactor', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const source = textContent(context.messages.findLast(m => m.role === 'user')?.content).split('\n').at(-2) ?? ''; // the last input line, before </input>
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: `summary of ${source}` }], api: model.api, provider: model.provider,
        model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      stream.push({ type: 'start', partial: message });
      const step = <T>() => { let resolve = (_: T) => {}; return { promise: new Promise<T>(r => { resolve = r; }), resolve }; };
      const answered = step<string | undefined>(), finished = step<void>();
      calls.push({ source, answer: () => answered.resolve(undefined), fail: (error = 'invalid request', stop?: string) => { message.rawStopReason = stop; answered.resolve(error); }, finish: () => finished.resolve() });
      void (async () => {
        const error = await answered.promise;
        if (error) {
          message.stopReason = 'error'; message.errorMessage = error;
          stream.push({ type: 'error', reason: 'error', error: message }); return stream.end();
        }
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'summary', partial: message });
        await finished.promise;
        stream.push({ type: 'done', reason: 'stop', message }); stream.end();
      })();
      return stream;
    },
  });
  const compress = createCompressor(new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'compactor', thinking: 'off' }), undefined, undefined, [0, 0]);
  // Long enough for a cache mark, so the first 50k characters are a shared, cacheable prefix.
  const view = `<chat>\n${'0+1|user: an old remembered line\n'.repeat(2000)}</chat>`;
  // The compactor only sees sources over NODE bytes; the fake model reads just the last line.
  const run = (source: string, context = view, signal = new AbortController().signal) => compress({ context, source: `${'x'.repeat(600)}\n${source}`, part: { l: 0, i: 0 } }, signal);
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  return { calls, run, settle, view };
}

test('parallel calls on a cold view wait until one call has started answering, and a warm view skips the wait', async () => {
  const { calls, run, settle, view } = await setup();
  const replies = ['a', 'b', 'c'].map(source => run(source));
  await settle();
  assert.deepEqual(calls.map(c => c.source), ['a'], 'only the primer starts while the shared view is cold');
  calls[0].answer();
  await settle();
  assert.deepEqual(calls.map(c => c.source), ['a', 'b', 'c'], 'the rest start together once the primer answers, before it finishes');
  calls.forEach(c => { c.answer(); c.finish(); });
  assert.deepEqual(await Promise.all(replies), ['summary of a', 'summary of b', 'summary of c']);
  const warm = run('d', view.replace('</chat>', 'user: one new line\n</chat>'));
  await settle();
  assert.equal(calls.length, 4, 'a newer view with the same cached prefix starts right away');
  calls[3].answer(); calls[3].finish();
  await warm;
});

test('a call whose view runs past a cold prefix that is being primed waits for that primer', { timeout: 5000 }, async () => {
  const { calls, run, settle, view } = await setup();
  const longer = view.replace('</chat>', '0+1|user: a newer line\n'.repeat(4) + '</chat>');
  const replies = [run('a'), run('b', longer)];
  await settle();
  assert.deepEqual(calls.map(c => c.source), ['a'], 'the longer view waits for the shorter one being primed');
  calls[0].answer();
  await settle();
  assert.deepEqual(calls.map(c => c.source), ['a', 'b']);
  calls.forEach(c => { c.answer(); c.finish(); });
  await Promise.all(replies);
});

test('a failing primer releases the waiting calls instead of hanging them', { timeout: 5000 }, async () => {
  const { calls, run, settle } = await setup();
  const replies = ['a', 'b', 'c'].map(source => run(source).catch((error: Error) => error.message));
  await settle();
  calls[0].fail();
  await settle();
  assert.equal(calls.length, 2, 'the next waiter primes in its place');
  calls[1].answer();
  await settle();
  calls.slice(1).forEach(c => { c.answer(); c.finish(); });
  assert.deepEqual(await Promise.all(replies), ['invalid request', 'summary of b', 'summary of c']);
});

test('a waiting call that is cancelled stops at once without ever calling the model', { timeout: 5000 }, async () => {
  const { calls, run, settle, view } = await setup();
  const primer = run('a'), cancel = new AbortController();
  const waiter = run('b', view, cancel.signal);
  await settle();
  cancel.abort();
  await assert.rejects(waiter, { name: 'AbortError' });
  calls[0].answer(); calls[0].finish();
  await primer;
  assert.deepEqual(calls.map(c => c.source), ['a']);
});

test('a dropped connection is asked again quietly instead of failing the summary', { timeout: 5000 }, async () => {
  const { calls, run, settle } = await setup();
  const reply = run('a');
  await settle();
  calls[0].fail('terminated');
  await settle();
  calls[1].answer(); calls[1].finish();
  assert.equal(await reply, 'summary of a');
});

test('an error that is not transient surfaces at once, and a transient one after two retries', { timeout: 5000 }, async () => {
  const { calls, run, settle } = await setup();
  const invalid = run('a').catch((error: Error) => error.message);
  await settle();
  calls[0].fail('invalid request');
  assert.equal(await invalid, 'invalid request');
  const dropped = run('b').catch((error: Error) => error.message);
  for (let i = 1; i <= 3; i++) { await settle(); calls[i].fail('terminated'); }
  assert.equal(await dropped, 'terminated');
  assert.equal(calls.length, 4);
});

test('a provider stop that names a network error is asked again, and never kept as a refusal', { timeout: 5000 }, async () => {
  const { calls, run, settle } = await setup();
  const network = () => calls.at(-1)!.fail('Provider finish_reason: network_error', 'network_error'); // what pi-ai's OpenAI completions API reports
  const recovered = run('a');
  await settle(); network();
  await settle(); calls[1].answer(); calls[1].finish();
  assert.equal(await recovered, 'summary of a', 'one network stop is retried and the next reply is used');
  const down = run('b').catch((error: Error) => error);
  for (let i = 0; i < 3; i++) { await settle(); network(); }
  const error = await down;
  assert.ok(error instanceof Error && !(error instanceof Refused), 'still down after the retries: a plain error, so the summary is tried again later, not given up');
  assert.equal(calls.length, 5);
});

test("a provider's own 'error' stop is a plain error, not a refusal", { timeout: 5000 }, async () => {
  const { calls, run, settle } = await setup();
  const reply = run('a').catch((error: Error) => error);
  for (let i = 0; i < 3; i++) { await settle(); calls.at(-1)!.fail('Provider stopped with: error', 'error'); } // what pi-ai's Mistral API reports
  const error = await reply;
  assert.ok(error instanceof Error && !(error instanceof Refused), 'the summary is tried again later, not kept raw');
});

test('a refusal the model itself stops with is final, without asking again', { timeout: 5000 }, async () => {
  const { calls, run, settle } = await setup();
  const reply = run('a');
  await settle();
  calls[0].fail('The model refused to complete the request', 'refusal');
  await assert.rejects(reply, Refused);
  assert.equal(calls.length, 1);
});

test('a warm view stays warm while longer views read it, so an older merge view still skips the primer after 4 minutes', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { calls, run, settle, view } = await setup();
  const longer = view.replace('</chat>', '0+1|user: a newer line\n'.repeat(4) + '</chat>');
  const primer = run('a');
  await settle(); calls[0].answer(); calls[0].finish(); await primer;
  for (let minute = 1; minute <= 5; minute++) {
    t.mock.timers.setTime(Date.now() + 60_000);
    const reading = run(`longer ${minute}`, longer);
    await settle(); calls.at(-1)!.answer(); calls.at(-1)!.finish(); await reading;
  }
  // Five minutes after its primer, but read a minute ago by a longer view: two calls on the older view both start at once.
  const older = [run('b'), run('c')];
  await settle();
  assert.deepEqual(calls.slice(-2).map(c => c.source), ['b', 'c'], 'neither waits for a primer');
  calls.slice(-2).forEach(c => { c.answer(); c.finish(); });
  await Promise.all(older);
});
