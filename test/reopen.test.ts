import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { listBranches } from '../src/branch.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

async function start(dir: string) {
  mkdirSync(dir, { recursive: true });
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model) {
      const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'ok' }],
        timestamp: Date.now(), stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message: reply });
      stream.end();
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
    resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date'] });
  const notes: string[] = [];
  // The TUI reports a refused start with notify(); a menu that cannot be answered counts as "go back".
  const uiContext = { ...session.extensionRunner.getUIContext(), notify: (text: string) => { notes.push(text); }, select: async () => undefined };
  await session.bindExtensions({ uiContext, mode: 'tui' });
  return { session, notes };
}

// Pi's RPC mode binds extensions twice after a session switch, so the same session starts twice in one process (upstream #258).
test('binding the same session twice keeps the profile and branch this process already holds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-reopen-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  let session: Awaited<ReturnType<typeof start>>['session'] | undefined;
  try {
    createProfile('fixture');
    const profile = profilePath('fixture'), fixture = { provider: 'fixture', model: 'fixture', thinking: 'off' as const };
    saveConfig(profile, { ...loadConfig(profile), compactor: fixture, subagent: fixture });

    const started = await start(join(dir, 'project'));
    session = started.session;
    await session.prompt('hello');
    const open = () => listBranches(profile).filter(b => !b.closed).map(b => b.id);
    const before = open();
    assert.equal(before.length, 1);

    await session.bindExtensions({ mode: 'tui' });
    assert.deepEqual(open(), before, 'the second start opens no second branch for the same session');
    assert.deepEqual(started.notes.filter(note => /already running|does not exist|Choose an OptChat profile|could not/i.test(note)), [],
      'the second start reports no busy or missing profile');
    await session.prompt('still here');
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});

// A host that swaps in another session without a session_shutdown for the first: the first one's branch is closed and merged,
// as on shutdown, before the new session opens its own.
test('a different session binding over one still open closes the old branch first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-reopen-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  let session: Awaited<ReturnType<typeof start>>['session'] | undefined;
  try {
    createProfile('fixture');
    const profile = profilePath('fixture'), fixture = { provider: 'fixture', model: 'fixture', thinking: 'off' as const };
    saveConfig(profile, { ...loadConfig(profile), compactor: fixture, subagent: fixture });

    const started = await start(join(dir, 'project'));
    session = started.session;
    await session.prompt('hello from the first session');
    const [first] = listBranches(profile).filter(b => !b.closed).map(b => b.id);
    assert.ok(first);

    const manager = session.sessionManager, before = manager.getSessionId();
    manager.newSession();
    assert.notEqual(manager.getSessionId(), before);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    await session.bindExtensions({ mode: 'tui' });

    const open = listBranches(profile).filter(b => !b.closed).map(b => b.id);
    assert.equal(open.length, 1, "only the new session's branch is open");
    assert.notEqual(open[0], first);
    assert.ok(listBranches(profile).find(b => b.id === first)?.closed, 'the old branch was closed');
    const trunk = readdirSync(join(profile, 'main')).map(file => readFileSync(join(profile, 'main', file), 'utf8')).join('');
    assert.match(trunk, /hello from the first session/, 'and merged into the trunk');
    await session.prompt('hello from the second session');
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});
