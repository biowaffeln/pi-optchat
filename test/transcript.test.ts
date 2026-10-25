import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type ImageContent, type TextContent, type UserMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { asUser, buildContext, PREVIOUS_EXCHANGE, previousExchange, REPORT_TYPE, RUN_BOUNDARY, textContent, typedText } from '../src/transcript.ts';
import { COMPACT } from '../src/prompts.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';
import { lastBranchDir, sessionLog } from './branches-support.ts';

const user = (content: UserMessage['content']): UserMessage => ({ role: 'user', content, timestamp: 1 });
const answer = (text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({
  role: 'assistant', content: [{ type: 'text', text }], timestamp: 2, stopReason,
  api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: emptyUsage(),
});
function appendRun(manager: SessionManager, messages: Parameters<SessionManager['appendMessage']>[0][], settled = true) {
  manager.appendCustomEntry(RUN_BOUNDARY, { state: 'start' });
  for (const message of messages) manager.appendMessage(message);
  if (settled) manager.appendCustomEntry(RUN_BOUNDARY, { state: 'end' });
}

test('retain the exact last answer and its requests, excluding prior working context', () => {
  const first = user('Compare the options.');
  const steering = user([{ type: 'text', text: 'Focus on option two.' }, { type: 'image', data: 'image-bytes', mimeType: 'image/png' }]);
  const finalText = 'Second option: preserve original wording.\n' + 'Detailed explanation. '.repeat(70);
  const final = answer(finalText);
  final.content.unshift({ type: 'thinking', thinking: 'OLD PRIVATE REASONING' });
  const toolResult: AgentMessage = { role: 'toolResult', toolCallId: 'read', toolName: 'read',
    content: [{ type: 'text', text: 'OLD TOOL OUTPUT' }], isError: false, timestamp: 1 };
  const history = [user('Older question'), answer('Older answer'), first, answer('Checking.', 'toolUse'), toolResult, steering, final];
  const manager = SessionManager.inMemory();
  appendRun(manager, history.slice(0, 2));
  appendRun(manager, history.slice(2));
  const previous = previousExchange(manager.getBranch());
  const [request, steered, reply] = previous.map(m => textContent(m.content));
  assert.deepEqual([request, reply], [first.content, finalText]);
  assert.match(steered, /^Focus on option two\.\n\[image [0-9a-f]{16}\]$/);
  const current = user('Why is that?');
  const thinking = answer('Working on the follow-up.');
  thinking.content.unshift({ type: 'thinking', thinking: 'CURRENT REASONING' });
  const context = buildContext([...history, current, thinking], [current, thinking], '<chat>\nsummary\n</chat>', 'instructions', previous);
  assert.deepEqual(context.map(m => m.role), ['system', 'user', 'user', 'assistant', 'user', 'assistant']);
  assert.ok(context[3].role === 'assistant');
  assert.equal(textContent(context[3].content), finalText);
  assert.equal(context.at(-1), thinking);
  assert.ok(context[1].role === 'user');
  assert.match(textContent(context[1].content), /^<chat>\nsummary\n<\/chat>/);
  assert.doesNotMatch(JSON.stringify(context), /OLD PRIVATE REASONING|OLD TOOL OUTPUT|Older question|Older answer|image-bytes/);
  assert.throws(() => buildContext(history, [], 'view', 'prompt', previous), /no current user message/);
  assert.equal(final.content[0].type, 'thinking', 'the saved transcript must not be mutated');
});

test('unsuccessful or unsettled runs preserve the earlier completed exchange', () => {
  const completed = [user('Earlier'), answer('Earlier answer')];
  for (const reason of ['error', 'aborted', 'length', 'toolUse'] as const) {
    const manager = SessionManager.inMemory();
    appendRun(manager, completed);
    appendRun(manager, [user('New task'), answer('Partial', reason)]);
    assert.deepEqual(previousExchange(manager.getBranch()), completed);
  }
  const manager = SessionManager.inMemory();
  appendRun(manager, completed);
  appendRun(manager, [user('Unanswered')], false);
  assert.deepEqual(previousExchange(manager.getBranch()), completed);
  manager.appendMessage(answer('Text-only response before a crash or pending steering'));
  assert.deepEqual(previousExchange(manager.getBranch()), completed);
  const orphan = SessionManager.inMemory();
  appendRun(orphan, [answer('Unpaired answer')]);
  assert.deepEqual(previousExchange(orphan.getBranch()), []);
  assert.deepEqual(previousExchange([]), []);
});

test('a previous exchange up to the size limit is replayed in full', () => {
  const manager = SessionManager.inMemory();
  const request = 'x'.repeat(PREVIOUS_EXCHANGE / 2), reply = 'y'.repeat(PREVIOUS_EXCHANGE / 2);
  appendRun(manager, [user(request), answer(reply)]);
  assert.deepEqual(previousExchange(manager.getBranch()).map(m => textContent(m.content)), [request, reply]);
});

test('an oversized previous exchange is left out entirely, not swapped for an older one', () => {
  const manager = SessionManager.inMemory();
  appendRun(manager, [user('Earlier'), answer('Earlier answer')]);
  appendRun(manager, [user('Paste: ' + 'x'.repeat(PREVIOUS_EXCHANGE)), answer('Done.')]);
  assert.deepEqual(previousExchange(manager.getBranch()), []);
});

test('legacy sessions recover the last successful exchange before run markers were available', () => {
  const manager = SessionManager.inMemory();
  const completed = [user('Earlier'), answer('Earlier answer')];
  for (const message of [...completed, user('Failed task'), answer('Partial', 'error')]) manager.appendMessage(message);
  assert.deepEqual(previousExchange(manager.getBranch()), completed);
  appendRun(manager, [user('Unanswered')], false);
  assert.deepEqual(previousExchange(manager.getBranch()), completed);
});

test('real Pi lifecycle retains one exchange across tool calls and resume, without replaying it into memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-context-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const captured: Context[] = [];
  const errors: string[] = [];
  let notifySteeringStarted!: () => void;
  let releaseSteering!: () => void;
  const steeringStarted = new Promise<void>(resolve => { notifySteeringStarted = resolve; });
  const steeringRelease = new Promise<void>(resolve => { releaseSteering = resolve; });
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
        const snapshot = structuredClone(context);
        snapshot.messages = snapshot.messages.filter(m => m.role !== 'system');
        if (!compression) captured.push(snapshot);
        const latest = context.messages.at(-1);
        const text = textContent(latest?.content);
        const reply = answer(compression ? 'Summary of fixture exchanges.' : latest?.role === 'toolResult' ? 'Because Append preserves existing summaries.' : `Answer to: ${text.split('</chat>').at(-1)?.trim()}`);
        reply.api = model.api; reply.provider = model.provider; reply.model = model.id;
        if (text === 'Why is that?') {
          reply.stopReason = 'toolUse';
          reply.content = [{ type: 'toolCall', id: 'zoom-1', name: 'zoom', arguments: { id: 0, n: 1 } }];
        }
        const stream = createAssistantMessageEventStream();
        void (async () => {
          if (text === 'Task with constraints.') {
            stream.push({ type: 'start', partial: reply });
            notifySteeringStarted();
            await steeringRelease;
          }
          if (text === 'Fail now.') {
            reply.stopReason = 'error'; reply.errorMessage = 'Synthetic failure';
            stream.push({ type: 'error', reason: 'error', error: reply });
          } else stream.push({ type: 'done', reason: reply.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: reply });
          stream.end();
        })();
        return stream;
      },
    });
    const open = async (manager: SessionManager) => {
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
        noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
      await loader.reload();
      const created = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
        resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date'] });
      session = created.session;
      await session.bindExtensions({ onError: error => errors.push(error.error) });
      return session;
    };
    const close = async () => {
      if (!session) return;
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose(); session = undefined;
    };
    const manager = SessionManager.create(dir, join(dir, 'sessions'));
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    let active = await open(manager);
    await active.prompt('Should I append?');
    assert.equal(captured[0].messages.length, 1);
    const firstAnswer = active.getLastAssistantText();
    await active.prompt('Why is that?');
    const followUp = captured[1].messages;
    assert.deepEqual(followUp.map(m => m.role), ['user', 'assistant', 'user']);
    assert.equal(textContent(followUp[1].content), firstAnswer);
    assert.deepEqual(captured[2].messages.slice(0, 3), followUp, 'previous exchange must stay frozen during tools');
    assert.ok(captured[2].messages.some(m => m.role === 'toolResult'));
    await active.prompt('Okay.');
    assert.deepEqual(captured[3].messages.map(m => m.role), ['user', 'assistant', 'user']);
    assert.equal(textContent(captured[3].messages[1].content), 'Because Append preserves existing summaries.');
    assert.ok(!captured[3].messages.some(m => m.role === 'toolResult'));
    const saved = manager.getSessionFile(); assert.ok(saved);
    await close();
    active = await open(SessionManager.open(saved));
    await active.prompt('Explain that answer.');
    assert.equal(textContent(captured[4].messages[1].content), 'Answer to: Okay.');
    const steered = active.prompt('Task with constraints.');
    await steeringStarted;
    await active.steer('Also include tests.');
    releaseSteering();
    await steered;
    await close();
    active = await open(SessionManager.open(saved));
    await active.prompt('Check constraints.');
    const afterSteering = captured.at(-1)!.messages;
    assert.deepEqual(afterSteering.map(m => m.role), ['user', 'user', 'assistant', 'user']);
    assert.ok(textContent(afterSteering[0].content).endsWith('Task with constraints.'));
    assert.equal(textContent(afterSteering[1].content), 'Also include tests.');
    assert.equal(textContent(afterSteering[2].content), 'Answer to: Also include tests.');
    await active.prompt('Fail now.');
    assert.equal(active.messages.findLast(m => m.role === 'assistant')?.stopReason, 'error');
    await close();
    active = await open(SessionManager.open(saved));
    await active.prompt('Retry follow-up.');
    const afterFailure = captured.at(-1)!.messages;
    assert.deepEqual(afterFailure.map(m => m.role), ['user', 'assistant', 'user']);
    assert.ok(textContent(afterFailure[0].content).endsWith('Check constraints.'));
    assert.equal(textContent(afterFailure[1].content), 'Answer to: Check constraints.');
    await close();
    const fresh = SessionManager.inMemory(dir);
    fresh.appendCustomEntry('optchat.profile', { name: 'fixture' });
    active = await open(fresh);
    await active.prompt('Fresh session.');
    assert.equal(captured.at(-1)!.messages.length, 1, 'a new session must not replay another session\'s exchange');
    // The earlier sessions merged into the profile's log as they closed; the last is still open, with its messages in its branch.
    const log = sessionLog(profilePath('fixture'));
    assert.equal(log.length, 23, 'only actual requests, replies, one failure, and tool activity should be logged');
    assert.deepEqual(errors, []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});

test('another extension\'s shown custom message becomes a user message tagged with its type, images kept; reports and hidden messages stay as they are', () => {
  const custom = (customType: string, content: string | (TextContent | ImageContent)[], display = true) => asUser({ role: 'custom', customType, content, display, timestamp: 1 });
  const image = { type: 'image' as const, data: 'image-bytes', mimeType: 'image/png' };
  assert.deepEqual(custom('subagent_status', 'Subagent status: Scout stalled.'), { role: 'user', content: '[subagent_status] Subagent status: Scout stalled.', timestamp: 1 });
  assert.deepEqual(custom('screenshot', [{ type: 'text', text: 'Screenshot attached.' }, image]), { role: 'user', content: [{ type: 'text', text: '[screenshot] Screenshot attached.' }, image], timestamp: 1 });
  assert.deepEqual(custom('screenshot', [image]), { role: 'user', content: [{ type: 'text', text: '[screenshot]' }, image], timestamp: 1 });
  assert.deepEqual(custom(REPORT_TYPE, '[8964a512] Done.'), { role: 'user', content: '[8964a512] Done.', timestamp: 1 });
  assert.deepEqual(custom('plan-mode-context', '[PLAN MODE ACTIVE]', false), { role: 'custom', customType: 'plan-mode-context', content: '[PLAN MODE ACTIVE]', display: false, timestamp: 1 });
});

test('another extension\'s shown custom message starts a turn and stays in memory; context it hides and injects each turn reaches the model but not memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-custom-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const captured: Context['messages'][] = [];
  // As Pi's plan-mode example extension injects its instructions with every prompt while plan mode is on.
  const plan = '[PLAN MODE ACTIVE]\nYou are in plan mode.';
  let planning = false;
  const planMode = (pi: ExtensionAPI) => pi.on('before_agent_start', () => planning ? { message: { customType: 'plan-mode-context', content: plan, display: false } } : undefined);
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    saveConfig(profilePath('fixture'), { ...loadConfig(profilePath('fixture')), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
      modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const compression = context.messages.some(m => m.role === 'system' && m.content === COMPACT);
        if (!compression) captured.push(context.messages.filter(m => m.role !== 'system'));
        const reply = answer(compression ? 'Summary.' : `Answer to: ${textContent(context.messages.at(-1)?.content).split('</chat>').at(-1)?.trim()}`);
        reply.api = model.api; reply.provider = model.provider; reply.model = model.id;
        const stream = createAssistantMessageEventStream();
        stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end();
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat, planMode] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom'] })).session;
    await session.bindExtensions({});
    await session.prompt('Start the scout.');
    // As pi-interactive-subagents reports a finished subagent while Pi is idle.
    const result = 'Sub-agent "Scout" finished: found three files.';
    await session.sendCustomMessage({ customType: 'subagent_result', content: result, display: true }, { triggerTurn: true, deliverAs: 'steer' });
    await session.agent.waitForIdle();
    const tagged = `[subagent_result] ${result}`;
    assert.equal(session.getLastAssistantText(), `Answer to: ${tagged}`);
    assert.equal(textContent(captured.at(-1)!.at(-1)?.content), tagged);
    await session.prompt('What did it find?');
    assert.deepEqual(captured.at(-1)!.map(m => m.role), ['user', 'assistant', 'user']);
    assert.ok(textContent(captured.at(-1)![0].content).endsWith(tagged));
    assert.equal(textContent(captured.at(-1)![1].content), `Answer to: ${tagged}`);
    // The session is still open, so its messages are in its branch.
    const log = sessionLog(profilePath('fixture'));
    assert.ok(log.some(entry => entry.kind === 'user' && entry.text === tagged));
    planning = true;
    await session.prompt('Plan the change.');
    assert.ok(captured.at(-1)!.some(m => m.role === 'user' && textContent(m.content) === plan));
    const after = sessionLog(profilePath('fixture'));
    assert.ok(after.some(entry => entry.kind === 'user' && entry.text === 'Plan the change.'));
    assert.ok(!after.some(entry => entry.kind === 'user' && entry.text.includes('PLAN MODE')));
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});

test('main agent keeps Pi\'s AGENTS.md files and skills, with profile instructions last, and picks up AGENTS.md edits on the next run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-prompt-'));
  const agentDir = join(dir, 'agent');
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const profile = profilePath('fixture');
    saveConfig(profile, { ...loadConfig(profile), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    writeFileSync(join(profile, 'AGENTS.md'), 'PROFILE_RULES');
    mkdirSync(join(agentDir, 'skills', 'demo-skill'), { recursive: true });
    writeFileSync(join(agentDir, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: Demo skill.\n---\nBody');
    writeFileSync(join(agentDir, 'AGENTS.md'), 'GLOBAL_RULES');
    writeFileSync(join(dir, 'AGENTS.md'), 'REPO_RULES');
    const systems: string[] = [];
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
      modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const system = textContent(context.messages.find(m => m.role === 'system')?.content);
        if (system !== COMPACT) systems.push(system);
        const reply = answer(system === COMPACT ? 'Summary.' : 'Done.');
        reply.api = model.api; reply.provider = model.provider; reply.model = model.id;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(); });
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager, noExtensions: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date', 'read'] })).session;
    await session.bindExtensions({});
    await session.prompt('Hello.');
    const system = systems.at(-1) ?? '';
    assert.ok(system.includes('demo-skill'), 'skills are listed');
    const order = ['GLOBAL_RULES', 'REPO_RULES', 'PROFILE_RULES'].map(rule => system.indexOf(rule));
    assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), 'global, then repo AGENTS.md, then profile instructions last');
    writeFileSync(join(dir, 'AGENTS.md'), 'REPO_RULES_V2');
    await session.prompt('Again.');
    assert.ok(systems.at(-1)?.includes('REPO_RULES_V2'), 'an AGENTS.md edit reaches the next run without /reload');
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});

test('a /skill: command is logged once, as its expansion, and never recovered as an unanswered input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-skill-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const config = loadConfig(profilePath('fixture'));
    saveConfig(profilePath('fixture'), { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    mkdirSync(join(dir, 'skills', 'demo'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo skill.\n---\n\nFollow the demo steps.\n');
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
      modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model) {
        const reply = answer('Done.'); reply.api = model.api; reply.provider = model.provider; reply.model = model.id;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(); });
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true,
      noSkills: true, additionalSkillPaths: [join(dir, 'skills')], noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date'] })).session;
    await session.bindExtensions({});
    await session.prompt('/skill:demo   Do the task. ');
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose(); session = undefined;
    const main = join(dir, 'profiles', 'fixture', 'main');
    const log = readdirSync(main).flatMap(file => readFileSync(join(main, file), 'utf8').trim().split('\n')).map(line => JSON.parse(line));
    assert.deepEqual(log.map(entry => entry.kind), ['user', 'talk']);
    assert.match(log[0].text, /^<skill name="demo"[\s\S]*Follow the demo steps\.[\s\S]*Do the task\.$/);
    // The input journal is the session's own, in its branch: nothing left there for a recovery to log again.
    assert.deepEqual(JSON.parse(readFileSync(join(lastBranchDir(profilePath('fixture')), 'pending-inputs.json'), 'utf8')), []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});

/** Runs a second turn that waits on a summary which never lands: the compactor stalls, or fails with `failure`. Returns the working messages shown. */
async function waitForSummaries(failure: string | undefined, shown: (working: (string | undefined)[], asked: string[]) => boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-wait-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const working: (string | undefined)[] = [];
  const asked: string[] = [];
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
      streamSimple(model, context, options) {
        const compression = context.messages.some(m => m.role === 'system' && m.content === COMPACT);
        if (!compression) asked.push(context.messages.map(m => textContent(m.content)).join('\n'));
        const reply = answer(compression ? 'Summary.' : 'Done.'); reply.api = model.api; reply.provider = model.provider; reply.model = model.id;
        const stream = createAssistantMessageEventStream();
        if (compression && failure) {
          reply.stopReason = 'error'; reply.errorMessage = failure;
          // Fail only once the turn is waiting, so the message has to change while it is shown.
          const fail = () => working.at(-1) === 'Waiting for OptChat summaries…' ? (stream.push({ type: 'error', reason: 'error', error: reply }), stream.end()) : options?.signal?.aborted || setTimeout(fail, 10);
          fail();
        } else if (compression) {
          reply.stopReason = 'aborted'; reply.errorMessage = 'closed';
          options?.signal?.addEventListener('abort', () => { stream.push({ type: 'error', reason: 'aborted', error: reply }); stream.end(); }, { once: true });
        } else queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(); });
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date'] })).session;
    const ui = { setWorkingMessage: (message?: string) => { working.push(message); }, notify() {}, setStatus() {}, setWidget() {}, setTitle() {} } as unknown as ExtensionUIContext;
    await session.bindExtensions({ uiContext: ui });
    await session.prompt('First question. ' + 'padding '.repeat(400));
    working.length = 0;
    const second = session.prompt('Second question.');
    for (let i = 0; i < 200 && !shown(working, asked); i++) await new Promise(resolve => setTimeout(resolve, 10));
    const seen = [...working];
    await session.abort(); await second;
    return { seen, working, asked };
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
}

test('an aborted wait for summaries clears the working message', async () => {
  const { seen, working } = await waitForSummaries(undefined, w => w.includes('Waiting for OptChat summaries…'));
  assert.deepEqual(seen, ['Waiting for OptChat summaries…'], 'the second turn waits for summaries');
  assert.equal(working.at(-1), undefined, 'the message is cleared although the wait threw');
  assert.equal(working.length, 2);
});

test('a failing summarizer says why the turn is waiting, then the turn goes on without the missing summary', async () => {
  const { seen, asked } = await waitForSummaries('No API key for anthropic', (_, asked) => asked.length > 1);
  assert.deepEqual(seen.slice(0, 2), ['Waiting for OptChat summaries…', 'Waiting for OptChat summaries… failing: No API key for anthropic (see /optchat model)']);
  assert.equal(seen.at(-1), undefined, 'the message is cleared once the wait gives up');
  assert.match(asked.at(-1)!, /not summarized yet: zoom it\)[\s\S]*Second question\./);
});

// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('typed text drops image placeholders and the image notes Pi appends', () => {
  const content = [{ type: 'text', text: 'see\n\n[Image: original 4000x3000, displayed at 2000x1500. Multiply coordinates by 2.00 to map to original image.]\n[Image converted from image/gif to image/png.]' },
    { type: 'image', data: 'x', mimeType: 'image/png' }];
  assert.deepEqual(typedText(content), { text: content[0].text, bare: 'see' });
  assert.equal(typedText([{ type: 'text', text: 'plain [Image: kept]' }]).bare, 'plain [Image: kept]');
});

test('inputs with images are claimed too, including /skill: commands and Pi\'s image notes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-skill-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const config = loadConfig(profilePath('fixture'));
    saveConfig(profilePath('fixture'), { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    mkdirSync(join(dir, 'skills', 'demo'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo skill.\n---\n\nFollow the demo steps.\n');
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
      modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model) {
        const reply = answer('Done.'); reply.api = model.api; reply.provider = model.provider; reply.model = model.id;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(); });
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true,
      noSkills: true, additionalSkillPaths: [join(dir, 'skills')], noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date'] })).session;
    await session.bindExtensions({});
    const images = [{ type: 'image' as const, data: PNG, mimeType: 'image/png' }];
    await session.prompt('/skill:demo go', { images });
    await session.prompt('look at this', { images });
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose(); session = undefined;
    const main = join(dir, 'profiles', 'fixture', 'main');
    const log = readdirSync(main).flatMap(file => readFileSync(join(main, file), 'utf8').trim().split('\n')).map(line => JSON.parse(line));
    assert.deepEqual(log.map(entry => entry.kind), ['user', 'talk', 'user', 'talk']);
    assert.match(log[0].text, /^<skill name="demo"[\s\S]*\ngo\n\[image [0-9a-f]{16}\]$/);
    assert.match(log[2].text, /^look at this\n\[image [0-9a-f]{16}\]$/);
    assert.deepEqual(readdirSync(join(dir, 'profiles', 'fixture', 'images')).map(file => readFileSync(join(dir, 'profiles', 'fixture', 'images', file)).toString('base64')), [PNG]);
    // The input journal is the session's own, in its branch: nothing left there for a recovery to log again.
    assert.deepEqual(JSON.parse(readFileSync(join(lastBranchDir(profilePath('fixture')), 'pending-inputs.json'), 'utf8')), []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});

test('an input queued during a run and handed back by Esc is logged once, as sent, and never recovered later', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-esc-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const config = loadConfig(profilePath('fixture'));
    saveConfig(profilePath('fixture'), { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
      modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    let calls = 0, streaming = () => {};
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, _context, options) {
        const stream = createAssistantMessageEventStream();
        const end = (reason: 'stop' | 'aborted') => {
          const reply = answer(reason === 'stop' ? 'Done.' : '', reason); reply.api = model.api; reply.provider = model.provider; reply.model = model.id;
          stream.push(reason === 'stop' ? { type: 'done', reason, message: reply } : { type: 'error', reason, error: reply }); stream.end();
        };
        // Every other turn runs until it is aborted, like a long command.
        if (calls++ % 2 === 0) { options?.signal?.addEventListener('abort', () => end('aborted')); streaming(); }
        else queueMicrotask(() => end('stop'));
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true,
      noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date'] })).session;
    await session.bindExtensions({});
    const s = session;
    const handBack = async (queued: string, sent: string) => {
      const started = new Promise<void>(resolve => { streaming = resolve; });
      const long = s.prompt('Run a long command.');
      await started;
      await s.prompt(queued, { streamingBehavior: 'steer' });
      // What Esc does in Pi's editor: take the queued text back, then abort the run.
      s.clearQueue(); await s.abort(); await long;
      await s.prompt(sent);
    };
    await handBack('Reply with pineapple.', 'Reply with pineapple.');
    await handBack('Reply with mango.', 'Reply with mango, please.');
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); // recovers the journal, as /reload does
    session.dispose(); session = undefined;
    const main = join(dir, 'profiles', 'fixture', 'main');
    const log = readdirSync(main).flatMap(file => readFileSync(join(main, file), 'utf8').trim().split('\n')).map(line => JSON.parse(line));
    assert.deepEqual(log.filter(entry => entry.kind === 'user').map(entry => entry.text),
      ['Run a long command.', 'Reply with pineapple.', 'Run a long command.', 'Reply with mango, please.']);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});
