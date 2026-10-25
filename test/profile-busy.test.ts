import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { Memory } from '../src/memory.ts';
import { createProfile, isWindows, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { branchDirectory, listBranches } from '../src/branch.ts';
import { lockPath, LockBusy, takeLock } from '../src/locks.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';
import { logIn } from './branches-support.ts';

const agentDir = process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));
after(() => removeDir(agentDir));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// sun_path is 104 bytes on macOS and 108 elsewhere, both including the NUL; a Windows pipe path is capped at 259 characters.
const LIMIT = process.platform === 'darwin' ? 103 : isWindows ? 259 : 107;

/** A Pi whose model answers "Answer to: <prompt>". `notes` gets every notification, `errors` the error ones. */
async function start(dir: string, ui: Partial<ExtensionUIContext>, bound?: string) {
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const text = textContent(context.messages.at(-1)?.content).split('</chat>').at(-1)?.trim();
      const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: `Answer to: ${text}` }], timestamp: Date.now(),
        stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, usage: emptyUsage() };
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
  if (bound) manager.appendCustomEntry('optchat.profile', { name: bound });
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
    resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom'] });
  const titles: string[] = [], errors: string[] = [], notes: string[] = [];
  const uiContext: ExtensionUIContext = { ...session.extensionRunner.getUIContext(), setTitle: t => { titles.push(t); },
    notify: (text, type) => { notes.push(text); if (type === 'error') errors.push(text); }, ...ui };
  await session.bindExtensions({ uiContext, mode: 'tui' });
  const close = async () => { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); };
  return { session, titles, errors, notes, manager, close };
}
const fixtureProfile = (name: string) => {
  createProfile(name);
  const fixture = { provider: 'fixture', model: 'fixture', thinking: 'off' as const };
  saveConfig(profilePath(name), { ...loadConfig(profilePath(name)), compactor: fixture, subagent: fixture });
  return profilePath(name);
};

test('a profile an older OptChat holds fails to open, names its owner, and the session is not bound to it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-busy-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  let pi: Awaited<ReturnType<typeof start>> | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    const profile = fixtureProfile('busy');
    // An OptChat from before branches holds the profile's lock.sock and expects to be its only writer.
    release = await takeLock(lockPath(profile, 'lock'), () => 'busy · PID 1 · elsewhere');
    pi = await start(dir, { select: async () => 'busy' });
    assert.match(pi.errors.join('\n'), /This profile is open in an older OptChat \(busy · PID 1 · elsewhere\)\. Close that Pi first/);
    assert.deepEqual(pi.titles, [], 'no profile title, since nothing opened');
    const bound = pi.manager.getEntries().filter(e => e.type === 'custom' && e.customType === 'optchat.profile');
    assert.deepEqual(bound, [], 'a profile that did not open is not saved as the session\'s binding');
    assert.deepEqual(listBranches(profile), [], 'no branch was started beside the older OptChat');
  } finally {
    await pi?.close();
    await release?.(); await sleep(50);
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});

test('two Pis on one profile both open, each as its own branch, both answer, and the profile keeps both sessions once they close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-two-')), oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  let a: Awaited<ReturnType<typeof start>> | undefined, b: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const profile = fixtureProfile('shared');
    a = await start(dir, {}, 'shared');
    b = await start(dir, {}, 'shared');
    const open = listBranches(profile);
    assert.equal(open.length, 2);
    assert.ok(open.every(info => !info.closed), 'both branches are open');
    assert.notEqual(open[0].id, open[1].id);
    assert.match(b.notes.join('\n'), /1 other session open/, 'the second Pi says it is not alone');

    await a.session.prompt('Question from A');
    await b.session.prompt('Question from B');
    assert.equal(a.session.getLastAssistantText(), 'Answer to: Question from A');
    assert.equal(b.session.getLastAssistantText(), 'Answer to: Question from B');
    assert.deepEqual([...a.errors, ...b.errors], []);
    // Oldest first: A started before B.
    const [mine, theirs] = open.map(info => logIn(branchDirectory(profile, info.id)).map(e => e.text));
    assert.deepEqual(mine, ['Question from A', 'Answer to: Question from A'], 'each branch logs only its own session');
    assert.deepEqual(theirs, ['Question from B', 'Answer to: Question from B']);
    assert.deepEqual(logIn(profile), [], 'nothing reaches the profile\'s log while both are open');

    await a.close(); a = undefined;
    assert.deepEqual(logIn(profile).map(e => e.text), ['Question from A', 'Answer to: Question from A'], 'A merges as it closes');
    await b.close(); b = undefined;
    const trunk = logIn(profile).map(e => e.text);
    assert.deepEqual([trunk.slice(0, 2), trunk.slice(3)], [['Question from A', 'Answer to: Question from A'], ['Question from B', 'Answer to: Question from B']]);
    assert.match(trunk[2], new RegExp(`^Another session's messages follow: branch ${open[1].id}`), 'B\'s block says it ran alongside A');
    assert.ok(listBranches(profile).every(info => info.closed), 'both branches closed');
  } finally {
    await a?.close(); await b?.close();
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});

test('a client that hangs up early does not crash the process holding a lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-lock-')), path = lockPath(dir, 'live');
  const release = await takeLock(path, () => 'holder');
  try {
    for (let round = 0; round < 20; round++) {
      await Promise.all(Array.from({ length: 50 }, () => new Promise<void>(done => {
        const client = createConnection(path);
        client.on('error', () => done());
        client.on('connect', () => { client.destroy(); done(); });
      })));
      await sleep(5);
    }
    await sleep(100);
    await assert.rejects(takeLock(path, () => 'second'), error => error instanceof LockBusy && error.owner === 'holder');
  } finally {
    await release(); removeDir(dir);
  }
});

test('a held lock refuses a second taker, another folder\'s lock is its own, and a released lock can be taken again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-lock-')), other = mkdtempSync(join(tmpdir(), 'optchat-lock-'));
  const release = await takeLock(lockPath(dir, 'live'), () => 'test owner');
  try {
    await assert.rejects(takeLock(lockPath(dir, 'live'), () => 'second taker'), /test owner/);
    await (await takeLock(lockPath(other, 'live'), () => 'other folder'))();
  } finally { await release(); }
  await (await takeLock(lockPath(dir, 'live'), () => 'after release'))();
  removeDir(dir); removeDir(other);
});

test('two Pis with different TMPDIRs still find the same lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-lock-')), oldTmp = process.env.TMPDIR;
  const temps = [mkdtempSync(join(tmpdir(), 'optchat-tmp-a-')), mkdtempSync(join(tmpdir(), 'optchat-tmp-b-'))];
  process.env.TMPDIR = temps[0];
  const release = await takeLock(lockPath(dir, 'live'), () => 'first');
  try {
    process.env.TMPDIR = temps[1];
    await assert.rejects(takeLock(lockPath(dir, 'live'), () => 'second'), /first/);
  } finally {
    await release();
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    for (const path of [dir, ...temps]) removeDir(path);
  }
});

test('a regular file named like a lock socket is refused, not deleted', async (t) => {
  if (isWindows) return t.skip('a Windows pipe has no filesystem entry to be confused with a file');
  const dir = mkdtempSync(join(tmpdir(), 'optchat-lock-'));
  try {
    writeFileSync(lockPath(dir, 'live'), 'notes');
    await assert.rejects(takeLock(lockPath(dir, 'live'), () => 'holder'), /is not an OptChat socket/);
    assert.equal(readFileSync(lockPath(dir, 'live'), 'utf8'), 'notes');
  } finally { removeDir(dir); }
});

test('on Windows, another spelling of the same folder (casing or a junction) finds the same lock', async (t) => {
  if (!isWindows) return t.skip('POSIX keeps the socket file inside the folder, so every spelling already reaches it');
  const root = mkdtempSync(join(tmpdir(), 'optchat-alias-')), dir = join(root, 'Profile'), junction = join(root, 'link');
  mkdirSync(dir); symlinkSync(dir, junction, 'junction');
  const release = await takeLock(lockPath(dir, 'live'), () => 'holder');
  try {
    for (const alias of [dir.toUpperCase(), junction]) await assert.rejects(takeLock(lockPath(alias, 'live'), () => 'second'), /Busy: holder/);
  } finally { await release(); removeDir(root); }
});

test('a lock path over the system limit names OPTCHAT_HOME and its length without binding a truncated socket, and one at the limit locks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'optchat-limit-'));
  try {
    if (isWindows) {
      // The pipe name is hashed from the folder's path, so a long folder cannot overflow it; an over-long hand-built name is still refused before listen.
      const long = join(root, 'p'.repeat(200)); mkdirSync(long);
      await (await takeLock(lockPath(long, 'live'), () => 'holder'))();
      assert.match(lockPath(root, 'live'), /^\\\\\.\\pipe\\optchat-[0-9a-f]{16}-live$/);
      await assert.rejects(takeLock(`\\\\.\\pipe\\${'q'.repeat(251)}`, () => 'holder'), /OPTCHAT_HOME to a shorter directory/);
      return;
    }
    const fileLength = Buffer.byteLength(basename(lockPath(root, 'live')));
    const folderOf = (socketLength: number) => { const dir = join(root, 'q'.repeat(socketLength - fileLength - 1 - root.length - 1)); mkdirSync(dir); return dir; };
    const atLimit = folderOf(LIMIT), overLimit = folderOf(LIMIT + 1), long = join(root, 'p'.repeat(200));
    mkdirSync(long);

    assert.equal(Buffer.byteLength(lockPath(atLimit, 'live')), LIMIT);
    await (await takeLock(lockPath(atLimit, 'live'), () => 'holder'))();

    for (const dir of [overLimit, long]) {
      await assert.rejects(takeLock(lockPath(dir, 'live'), () => 'holder'), /over this system's limit.*OPTCHAT_HOME to a shorter directory/);
      await assert.rejects(takeLock(lockPath(dir, 'live'), () => 'holder'), new RegExp(`${Buffer.byteLength(lockPath(dir, 'live'))} bytes`));
      assert.deepEqual(readdirSync(dir), [], 'no truncated socket was bound');
    }
  } finally {
    removeDir(root);
  }
});

test('a stray write to the profile\'s log while a session is open is kept, and the session\'s messages merge after it when it closes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-writer-')), oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  let pi: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const profile = fixtureProfile('shared');
    pi = await start(dir, { select: async () => 'shared' });
    // Something other than a branch appends to the profile's log behind the session's back, without the trunk lock.
    const other = new Memory(profile, async () => 'summary', () => {});
    other.append('user', 'written by the other process'); await other.close();

    await pi.session.prompt('Question for the first process');
    await pi.session.agent.waitForIdle();
    assert.equal(pi.session.getLastAssistantText(), 'Answer to: Question for the first process', 'the session never writes that log, so it goes on');
    assert.deepEqual(pi.errors, []);
    await pi.close(); pi = undefined;
  } finally {
    await pi?.close();
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  }
  const reopened = new Memory(join(dir, 'home', 'profiles', 'shared'), async () => 'summary', () => {});
  try {
    const texts = reopened.root.map(e => e.text);
    assert.equal(texts[0], 'written by the other process', 'the stray message is kept');
    assert.match(texts[1], /^Another session's messages follow: branch [0-9a-f]{6}/, 'the merge lands after it, saying where it came from');
    assert.deepEqual(texts.slice(2), ['Question for the first process', 'Answer to: Question for the first process'], 'and nothing of the session is lost');
  } finally { await reopened.close(); removeDir(dir); }
});
