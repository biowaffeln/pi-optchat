import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, CustomMessageComponent, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager,
  UserMessageComponent, type ExtensionAPI, type MessageRenderer } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { registerReportRenderer, reportParts } from '../src/report-message.ts';
import { REPORT_TYPE, textContent, withoutFullChat } from '../src/transcript.ts';
import { COMPACT } from '../src/prompts.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

initTheme('dark', false);
const plain = (lines: string[]) => lines.join('\n').replace(/\x1b\[[0-9;:]*[A-Za-z]|\x1b[\]_][^\x07\x1b]*(\x07|\x1b\\)/g, '');
const backgrounds = (lines: string[]) => new Set(lines.join('').match(/\x1b\[48;[0-9;]+m/g) ?? []);

test('subagent messages render as a dark labelled box, never in the user-message colour', () => {
  assert.deepEqual(reportParts('[8964a512] Message from subagent (still running): step 1 done'), { label: 'subagent 8964a512 · still running', body: 'step 1 done' });
  assert.deepEqual(reportParts('[8964a512] All done.'), { label: 'subagent 8964a512 · report', body: 'All done.' });
  assert.deepEqual(reportParts('no id'), { label: 'subagent', body: 'no id' });
  assert.deepEqual(reportParts('[8964a512] One.\n\n[0f6d1168] Two.', 2), { label: '2 subagent reports', body: '[8964a512] One.\n\n[0f6d1168] Two.' });
  // One report quoting a child's is still one report: the count comes with the message, not from its text.
  assert.equal(reportParts('[8964a512] Heard: [0f6d1168] a done\n\n[1c2d3e4f] b done').label, 'subagent 8964a512 · report');
  let renderer: MessageRenderer | undefined;
  registerReportRenderer({ registerMessageRenderer: (_type: string, r: MessageRenderer) => { renderer = r; } } as unknown as ExtensionAPI);
  const message = { role: 'custom' as const, customType: REPORT_TYPE, content: '[8964a512] Message from subagent (still running): **step 1** done', display: true, timestamp: 1 };
  const lines = new CustomMessageComponent(message, renderer).render(80);
  const grouped = { ...message, content: '[8964a512] One.\n\n[0f6d1168] Two.', details: { count: 2 } };
  assert.match(plain(new CustomMessageComponent(grouped, renderer).render(80)), /↳ 2 subagent reports/);
  const text = plain(lines);
  assert.match(text, /↳ subagent 8964a512 · still running/);
  assert.match(text, /step 1 done/);
  assert.doesNotMatch(text, /\[8964a512\]|\[optchat-report\]/);
  const userBg = backgrounds(new UserMessageComponent('typed by you').render(80));
  const reportBg = backgrounds(lines);
  assert.ok(reportBg.size > 0, 'the report has its own background');
  for (const bg of userBg) assert.ok(!reportBg.has(bg), 'the report must not use the user-message background');
});

test('a report reaches an idle or busy main agent as a user message to the model, as work in memory, with the same system prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-report-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const captured: Context[] = [];
  const systems: string[] = [];
  let notifyHeld!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { notifyHeld = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const config = loadConfig(profilePath('fixture'));
    saveConfig(profilePath('fixture'), { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
      modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const compression = context.messages.some(m => m.role === 'system' && m.content === COMPACT);
        const text = textContent(context.messages.at(-1)?.content);
        if (!compression) {
          const snapshot = structuredClone(context);
          systems.push(textContent(snapshot.messages.find(m => m.role === 'system')?.content));
          snapshot.messages = snapshot.messages.filter(m => m.role !== 'system');
          captured.push(snapshot);
        }
        const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: compression ? 'Summary.' : `Answer to: ${text.split('</chat>').at(-1)?.trim()}` }],
          timestamp: Date.now(), stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, usage: emptyUsage() };
        const stream = createAssistantMessageEventStream();
        void (async () => {
          if (text.endsWith('Long task.')) { stream.push({ type: 'start', partial: reply }); notifyHeld(); await released; }
          stream.push({ type: 'done', reason: 'stop', message: reply });
          stream.end();
        })();
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.create(dir, join(dir, 'sessions'));
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date'] })).session;
    const errors: string[] = [];
    await session.bindExtensions({ onError: error => errors.push(error.error) });
    const report = (text: string) => session!.sendCustomMessage({ customType: REPORT_TYPE, content: text, display: true }, { triggerTurn: true, deliverAs: 'steer' });

    await session.prompt('Start a subagent.');
    // Idle: Pi runs the report without before_agent_start, so OptChat must start the run itself.
    await report('[8964a512] Message from subagent (still running): step 1 done');
    await session.agent.waitForIdle();
    const idle = captured.at(-1)!.messages;
    assert.equal(idle.at(-1)?.role, 'user');
    assert.ok(textContent(idle.at(-1)!.content).endsWith('[8964a512] Message from subagent (still running): step 1 done'));
    assert.equal(systems.at(-1), systems[0], 'the report run reuses the main system prompt');
    assert.ok(systems[0].length > 0);

    // The next question sees the report as the previous exchange's request.
    await session.prompt('What did it say?');
    const next = captured.at(-1)!.messages;
    assert.deepEqual(next.map(m => m.role), ['user', 'assistant', 'user']);
    assert.ok(textContent(next[0].content).endsWith('step 1 done'));

    // Busy: the report is steered into the running turn.
    const running = session.prompt('Long task.');
    await held;
    await report('[8964a512] Final report.');
    release();
    await running;
    await session.agent.waitForIdle();
    assert.ok(captured.at(-1)!.messages.some(m => m.role === 'user' && textContent(m.content) === '[8964a512] Final report.'));

    const shown = manager.getBranch().filter(e => e.type === 'custom_message' && e.customType === REPORT_TYPE);
    assert.equal(shown.length, 2, 'both reports are stored as custom messages, so Pi draws them with our renderer');
    assert.ok(!manager.getBranch().some(e => e.type === 'message' && e.message.role === 'user' && textContent(e.message.content).startsWith('[8964a512]')));
    const main = join(dir, 'profiles', 'fixture', 'main');
    const log = readdirSync(main).flatMap(file => readFileSync(join(main, file), 'utf8').trim().split('\n')).map(line => JSON.parse(line) as { kind: string; text: string });
    assert.ok(log.some(e => e.kind === 'work' && e.text === '[8964a512] Message from subagent (still running): step 1 done'));
    assert.ok(log.some(e => e.kind === 'work' && e.text === '[8964a512] Final report.'));
    assert.ok(log.some(e => e.kind === 'user' && e.text === 'Start a subagent.'), 'what the user typed stays user');
    assert.deepEqual(errors, []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});

test('reports a crash held back with unfinished siblings are delivered at the next start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-held-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const asked: string[] = [];
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const profile = profilePath('fixture');
    saveConfig(profile, { ...loadConfig(profile), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    // Pi died after one child of a two-child spawn finished: its report was journaled, held for its sibling.
    writeFileSync(join(profile, 'pending-reports.json'), JSON.stringify([{ text: '[8964a512] a done', count: 1, batch: '8964a512' }]));
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context) {
        if (!context.messages.some(m => m.role === 'system' && m.content === COMPACT)) asked.push(textContent(context.messages.at(-1)?.content));
        const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: Date.now(), stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, usage: emptyUsage() };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(); });
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.create(dir, join(dir, 'sessions'));
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date'] })).session;
    const errors: string[] = [];
    await session.bindExtensions({ onError: error => errors.push(error.error) });
    for (const deadline = Date.now() + 10000; !asked.some(t => t.endsWith('[8964a512] a done'));) {
      if (Date.now() > deadline) throw new Error(`Held report not delivered: ${errors.join('; ')}`);
      await new Promise(r => setTimeout(r, 10));
    }
    await session.agent.waitForIdle();
    assert.deepEqual(JSON.parse(readFileSync(join(profile, 'pending-reports.json'), 'utf8')), [], 'logged to memory, it leaves the journal');
    assert.deepEqual(errors, []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});

test('a report steered into a running turn reaches the main agent once, even when Esc clears Pi\'s queue or an abort leaves it queued', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-lost-'));
  const oldHome = process.env.OPTCHAT_HOME, oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.OPTCHAT_HOME = dir;
  process.env.PI_CODING_AGENT_DIR = join(dir, 'agent'); // Children load installed extensions from here.
  const until = async (predicate: () => boolean, what: string) => {
    for (const deadline = Date.now() + 10000; !predicate();) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${what}`);
      await new Promise(r => setTimeout(r, 10));
    }
  };
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const profile = profilePath('fixture'), fixture = { provider: 'fixture', model: 'fixture', thinking: 'off' as const };
    saveConfig(profile, { ...loadConfig(profile), compactor: fixture, subagent: fixture });
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    const main: string[] = [];
    let release = () => {}, hold = true, settling = false;
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context, options) {
        const last = context.messages.at(-1), text = textContent(last && 'content' in last ? last.content : '');
        const compression = context.messages.some(m => m.role === 'system' && m.content === COMPACT), child = text.includes('\n\nYour task:\n');
        if (!compression && !child) main.push(withoutFullChat(text));
        const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: compression ? 'Summary.' : child ? 'Child done.' : 'ok' }],
          timestamp: Date.now(), stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, usage: emptyUsage() };
        if (!compression && !child && text.endsWith('Spawn one.')) {
          reply.content = [{ type: 'toolCall', id: 'spawn-1', name: 'spawn', arguments: { tasks: [{ task: hold ? 'Say done.' : 'Say done slowly.' }] } }]; reply.stopReason = 'toolUse';
        }
        const stream = createAssistantMessageEventStream();
        void (async () => {
          // After the spawn, main keeps writing until released or aborted, so the child's report waits in Pi's steering queue.
          if (child && text.endsWith('slowly.')) await new Promise(r => setTimeout(r, 300));
          if (last?.role === 'toolResult' && hold) {
            stream.push({ type: 'start', partial: reply });
            await new Promise<void>(resolve => { release = resolve; options?.signal?.addEventListener('abort', () => resolve(), { once: true }); });
          }
          if (options?.signal?.aborted) { reply.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: reply }); }
          else stream.push({ type: 'done', reason: reply.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: reply });
          stream.end();
        })();
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [(pi: ExtensionAPI) => {
        // Another extension's slow settle handler, during which the child reports: Pi is idle, so it holds that report for its own run.
        pi.on('agent_settled', async () => {
          if (!settling) return;
          settling = false;
          await until(() => readFileSync(join(profile, 'pending-reports.json'), 'utf8').includes('Child done.'), 'the child reports while settling');
        });
      }, optchat] });
    await loader.reload();
    const manager = SessionManager.create(dir, join(dir, 'sessions'));
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date', 'spawn'] })).session;
    const errors: string[] = [];
    await session.bindExtensions({ onError: error => errors.push(error.error) });
    const s = session;
    const work = () => readdirSync(join(profile, 'main')).flatMap(file => readFileSync(join(profile, 'main', file), 'utf8').trim().split('\n'))
      .map(line => JSON.parse(line) as { kind: string; text: string }).filter(e => e.kind === 'work' && e.text.includes('Child done.'));
    const reportTurn = async (stop: 'esc' | 'abort' | 'none') => {
      const before = work().length, running = s.prompt('Spawn one.');
      await until(() => s.agent.hasQueuedMessages(), 'the report is queued as a steer');
      // What Esc does in Pi's editor: take the queue back, then abort the run. A bare abort leaves the steer queued in Pi.
      if (stop === 'esc') s.clearQueue();
      if (stop === 'none') release(); else await s.abort();
      await running;
      await until(() => work().length > before && s.isIdle, 'the report is logged');
      await new Promise(r => setTimeout(r, 100)); // room for a wrong second delivery
    };

    await reportTurn('esc');
    assert.equal(work().length, 1, 'the cleared report is sent again after the turn, once');
    assert.equal(main.filter(t => t.endsWith('Child done.')).length, 1, 'the model sees it in one turn');
    assert.deepEqual(JSON.parse(readFileSync(join(profile, 'pending-reports.json'), 'utf8')), []);

    main.length = 0;
    await reportTurn('abort');
    assert.equal(work().length, 2, 'sent again, and also still in Pi\'s queue: the extra copy is dropped');
    assert.equal(main.filter(t => t.endsWith('Child done.')).length, 1);

    main.length = 0;
    await reportTurn('none');
    assert.equal(work().length, 3, 'a report that arrived in its turn is not sent again');
    assert.equal(main.filter(t => t.endsWith('Child done.')).length, 1);

    const dropped = () => s.messages.filter(m => m.role === 'custom' && textContent(m.content).startsWith('(duplicate')).length, droppedBefore = dropped();
    main.length = 0; hold = false; settling = true;
    await s.prompt('Spawn one.');
    await until(() => work().length > 3 && s.isIdle, 'the report sent while settling is logged');
    await new Promise(r => setTimeout(r, 100));
    assert.equal(work().length, 4);
    assert.equal(main.filter(t => t.endsWith('Child done.')).length, 1);
    assert.equal(dropped(), droppedBefore, 'a report sent while Pi settles already has its own run: not sent again');
    assert.deepEqual(errors, []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    removeDir(dir);
  }
});
