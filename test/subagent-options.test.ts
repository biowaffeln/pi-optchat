import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children, readOnlyAllowlist } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { modelsHint, READ_ONLY, READ_ONLY_BASH, READ_ONLY_NO_BASH } from '../src/prompts.ts';
import { READ_ONLY_TOOLS, type Sandbox } from '../src/sandbox.ts';
import { DEFAULT_ROLES, invalidRoles, rolesDoc, type Roles } from '../src/roles.ts';
import { RunHistory } from '../src/runs.ts';
import { loadConfig } from '../src/profiles.ts';
import { emptyUsage } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';
import { worktreePath } from '../src/worktree.ts';
import { removeDir } from './support.ts';

process.env.PI_CODING_AGENT_DIR ??= mkdtempSync(join(tmpdir(), 'optchat-agent-'));

async function until(condition: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}

/** The prompt text and the tools in force at the end of a request's system messages. */
function systemOf(messages: Message[]) {
  const texts: string[] = [], tools = new Set<string>();
  for (const message of messages) if (message.role === 'system') {
    texts.push(textContent(message.content), ...Object.values(message.sections ?? {}).filter((v): v is string => typeof v === 'string'));
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return { system: texts.join('\n\n'), tools: [...tools].sort() };
}
/** What one model request carried. */
interface Asked { task: string; first: string; model: string; reasoning: string; system: string; tools: string[]; results: string[] }

/**
 * Children on a synthetic provider. A task `RUN: <command>` runs that bash command once, then answers; a task `HOLD` waits until
 * its request is aborted. Every request is recorded in `asked`.
 */
async function harness(dir: string, roles?: Roles, sandbox?: () => Sandbox | undefined) {
  const asked: Asked[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  const model = (id: string, reasoning: boolean) => ({ id, name: id, reasoning, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions', models: [model('child', false), model('deep', true)],
    streamSimple: (m, context, options) => {
      const first = textContent(context.messages.find(msg => msg.role === 'user')?.content);
      const task = first.split('Your task:\n').at(-1) ?? '';
      asked.push({ task, first, model: m.id, reasoning: String(options?.reasoning ?? 'off'), ...systemOf(context.messages),
        results: context.messages.flatMap(msg => msg.role === 'toolResult' ? [textContent(msg.content)] : []) });
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: `done: ${task}` }], api: m.api, model: m.id, provider: m.provider, stopReason: 'stop', timestamp: Date.now(), usage: emptyUsage() };
      const ran = context.messages.some(msg => msg.role === 'toolResult');
      const last = context.messages.at(-1);
      if (task.startsWith('RUN: ') && !ran) { message.content = [{ type: 'toolCall', id: `run-${asked.length}`, name: 'bash', arguments: { command: task.slice(5) } }]; message.stopReason = 'toolUse'; }
      // A resumed run gets the new message last; `RUN: ` there runs it too.
      else if (last?.role === 'user' && textContent(last.content).startsWith('RUN: ') && asked.filter(a => a.task === task).length > 1 && !textContent(last.content).includes('ran')) {
        message.content = [{ type: 'toolCall', id: `again-${asked.length}`, name: 'bash', arguments: { command: textContent(last.content).slice(5) } }]; message.stopReason = 'toolUse';
      }
      void (async () => {
        if (task === 'HOLD') await new Promise<void>(resolve => {
          if (options?.signal?.aborted) return resolve();
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        if (options?.signal?.aborted) { message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); }
        else stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
        stream.end();
      })();
      return stream;
    },
  });
  const reports: string[] = [];
  /** Set to make every session open fail, as a broken extension would. */
  const control = { failOpen: false };
  const make = () => new Children(new Memory(join(dir, 'profile'), async input => input.source.slice(0, 100), () => {}), new ModelRegistry(runtime),
    () => ({ provider: 'optchat-test', model: 'child', thinking: 'off' }), () => '', async text => { reports.push(text); }, () => {}, join(dir, 'profile'),
    { settings: () => ({ subagentLevels: 2, maxAgents: 8 }), roles: roles && (() => roles), sandbox,
      createSession: options => control.failOpen ? Promise.reject(new Error('session failed to open')) : createAgentSession({ ...options, modelRuntime: runtime }) });
  return { asked, reports, make, control, children: make() };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
function repo(dir: string) {
  const path = join(dir, 'repo');
  mkdirSync(join(path, 'sub'), { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'config', 'user.email', 'test@example.com'); git(path, 'config', 'user.name', 'Test');
  writeFileSync(join(path, 'README.md'), 'hello\n'); writeFileSync(join(path, 'sub', 'keep.txt'), 'x\n');
  git(path, 'add', '-A'); git(path, 'commit', '-q', '-m', 'init');
  return realpathSync(path);
}
const branches = (path: string) => git(path, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();

const ROLES: Roles = {
  looker: { description: 'Looks around.', model: 'optchat-test/deep', thinking: 'low', tools: 'readonly', memory: false },
  builder: { description: 'Builds.' },
  ghost: { description: 'Uses a model Pi does not have.', model: 'optchat-test/missing' },
};

test('a role presets model, thinking, tools and memory; task fields override it; an unknown role or a role\'s missing model fails the spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-roles-')), { children } = await harness(dir, ROLES);
  try {
    const [looker, overridden, builder, plain] = children.resolve([{ task: 'a', role: 'looker' }, { task: 'b', role: 'looker', model: 'optchat-test/child', thinking: 'high', tools: 'all', memory: true },
      { task: 'c', role: 'builder' }, { task: 'd' }]);
    assert.deepEqual([looker.model.id, looker.thinking, looker.tools, looker.memory, looker.role], ['deep', 'low', 'readonly', false, 'looker']);
    assert.deepEqual([overridden.model.id, overridden.thinking, overridden.tools, overridden.memory], ['child', 'high', 'all', true], 'every task field wins over the role');
    assert.deepEqual([builder.model.id, builder.thinking, builder.tools, builder.memory], ['child', 'off', 'all', true], 'what the role leaves out is the profile\'s choice');
    assert.deepEqual([plain.model.id, plain.thinking, plain.tools, plain.memory, plain.role], ['child', 'off', 'all', true, undefined]);
    assert.equal(children.resolve([{ task: 'e', tools: 'all' }], 'readonly')[0].tools, 'readonly', 'a read-only parent\'s children are read-only');
    assert.throws(() => children.resolve([{ task: 'x', role: 'nope' }]), /Task 1: no role nope\. Roles: looker, builder, ghost\./);
    assert.throws(() => children.resolve([{ task: 'ok' }, { task: 'x', role: 'ghost' }]), /Task 2: role ghost's model is unavailable: optchat-test\/missing\. Pick another role or name a model\./);
    assert.equal(children.resolve([{ task: 'x', role: 'ghost', model: 'optchat-test/child' }])[0].model.id, 'child', 'naming a model rescues the role');
    await assert.rejects(children.spawn([{ task: 'fine' }, { task: 'x', role: 'ghost' }], dir), /role ghost's model is unavailable/);
    assert.equal(children.history.records.size, 0, 'nothing started');
  } finally { await children.close(); removeDir(dir); }
});

test('without roles in config.json the built-in four apply, and the prompt lists them with what they set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-default-roles-')), { children } = await harness(dir);
  try {
    assert.deepEqual(Object.keys(children.roles), ['scout', 'implementer', 'reviewer', 'elder']);
    assert.equal(DEFAULT_ROLES.reviewer.model, 'anthropic/claude-opus-5-5');
    assert.equal(DEFAULT_ROLES.elder.thinking, 'xhigh');
    assert.deepEqual([DEFAULT_ROLES.scout.tools, DEFAULT_ROLES.scout.memory, DEFAULT_ROLES.scout.model], ['readonly', false, 'openai-codex/gpt-6-luna']);
    // The test registry has no Anthropic login: a role that needs one fails clearly instead of running on the default.
    assert.throws(() => children.resolve([{ task: 'x', role: 'reviewer' }]), /role reviewer's model is unavailable: anthropic\/claude-opus-5-5/);
    const hint = modelsHint({ provider: 'p', model: 'm', thinking: 'medium' }, DEFAULT_ROLES);
    assert.match(hint, /Pick one freely/);
    assert.match(hint, /Set model or thinking yourself only when the user asks/);
    assert.match(hint, /- scout \(openai-codex\/gpt-6-luna, thinking low, read-only, no memory\): Fast read-only recon/);
    assert.match(hint, /- implementer \(subagent model\): Executes/);
    assert.equal(rolesDoc({}), '');
    assert.doesNotMatch(modelsHint({ provider: 'p', model: 'm', thinking: 'medium' }), /role/);
  } finally { await children.close(); removeDir(dir); }
});

test('config.json roles are validated and kept; a bad one names what is wrong', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-role-config-'));
  try {
    const base = { compactor: { provider: 'a', model: 'b', thinking: 'low' }, subagent: { provider: 'a', model: 'b', thinking: 'low' } };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(base));
    assert.equal(loadConfig(dir).roles, undefined);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...base, roles: ROLES }));
    assert.deepEqual(loadConfig(dir).roles, ROLES);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...base, roles: { x: { description: 'd', tools: 'some' } } }));
    assert.throws(() => loadConfig(dir), /Role x: tools must be all or readonly/);
    assert.match(invalidRoles({ x: { description: '' } })!, /needs a description/);
    assert.match(invalidRoles({ x: { description: 'd', model: 'nos lash' } })!, /provider\/id/);
    assert.match(invalidRoles({ x: { description: 'd', colour: 1 } })!, /unknown key colour/);
    assert.match(invalidRoles({ 'Bad Name': { description: 'd' } })!, /names are/);
    assert.equal(invalidRoles({}), undefined);
  } finally { removeDir(dir); }
});

test('the read-only allowlist is Pi\'s read-only tools plus OptChat\'s own, and drops bash without a sandbox', () => {
  assert.deepEqual([...READ_ONLY_TOOLS], ['read', 'grep', 'find', 'ls', 'bash']);
  assert.deepEqual(readOnlyAllowlist(['zoom', 'date', 'spawn', 'tell', 'tell_parent', 'read'], true), ['read', 'grep', 'find', 'ls', 'bash', 'zoom', 'date', 'spawn', 'tell', 'tell_parent']);
  assert.deepEqual(readOnlyAllowlist(['tell_parent'], false), ['read', 'grep', 'find', 'ls', 'tell_parent']);
  for (const name of ['edit', 'write', 'ast_grep_replace', 'codemode', 'tool_search']) assert.ok(!readOnlyAllowlist(['zoom'], true).includes(name));
});

test('a read-only child has exactly read, grep, find, ls, bash and OptChat\'s tools, and is told so; others keep edit and write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-readonly-')), { children, asked } = await harness(dir);
  try {
    await children.spawn([{ task: 'look', tools: 'readonly' }, { task: 'build' }], dir);
    await until(() => !children.active);
    const look = asked.find(a => a.task === 'look')!, build = asked.find(a => a.task === 'build')!;
    assert.deepEqual(look.tools, ['bash', 'date', 'find', 'grep', 'ls', 'models', 'read', 'spawn', 'tell', 'tell_parent', 'zoom']);
    for (const name of ['edit', 'write']) assert.ok(build.tools.includes(name), `all keeps ${name}`);
    assert.ok(look.system.includes(READ_ONLY) && look.system.includes(READ_ONLY_BASH));
    assert.ok(!look.system.includes(READ_ONLY_NO_BASH));
    assert.ok(!build.system.includes(READ_ONLY));
  } finally { await children.close(); removeDir(dir); }
});

test('without a sandbox a read-only child gets no bash and is told why', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-readonly-nobash-')), { children, asked } = await harness(dir, undefined, () => undefined);
  try {
    await children.spawn([{ task: 'look', tools: 'readonly' }, { task: 'build' }], dir);
    await until(() => !children.active);
    const look = asked.find(a => a.task === 'look')!, build = asked.find(a => a.task === 'build')!;
    assert.ok(!look.tools.includes('bash'), `no bash: ${look.tools}`);
    for (const name of ['read', 'grep', 'find', 'ls']) assert.ok(look.tools.includes(name));
    assert.ok(look.system.includes(READ_ONLY_NO_BASH) && !look.system.includes(READ_ONLY_BASH));
    assert.ok(build.tools.includes('bash'), 'a child with all tools keeps bash');
  } finally { await children.close(); removeDir(dir); }
});

test('an extension\'s tools are dropped from a read-only child, and its bash can\'t replace the sandboxed one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-readonly-ext-')), marker = join(dir, 'extension-bash-ran');
  const extensions = join(process.env.PI_CODING_AGENT_DIR!, 'extensions'), file = join(extensions, 'scribble.ts');
  mkdirSync(extensions, { recursive: true });
  writeFileSync(file, `import { writeFileSync } from 'node:fs';
const parameters = { type: 'object', properties: { command: { type: 'string' } } };
export default function (pi) {
  pi.registerTool({ name: 'scribble', label: 'Scribble', description: 'Writes files.', parameters, execute: async () => ({ content: [{ type: 'text', text: 'scribbled' }] }) });
  pi.registerTool({ name: 'bash', label: 'Bash', description: 'Unconfined bash.', parameters, execute: async () => { writeFileSync(${JSON.stringify(marker)}, 'x'); return { content: [{ type: 'text', text: 'unconfined' }] }; } });
}
`);
  const { children, asked } = await harness(dir, undefined, () => ({ kind: 'bwrap', argv: (shell, command) => [shell, '-c', command] }));
  try {
    await children.spawn([{ task: 'RUN: echo sandboxed', tools: 'readonly' }, { task: 'build' }], dir);
    await until(() => !children.active);
    const look = asked.filter(a => a.task === 'RUN: echo sandboxed'), build = asked.find(a => a.task === 'build')!;
    assert.ok(build.tools.includes('scribble'), `the extension loaded: ${build.tools}`);
    assert.ok(!look[0].tools.includes('scribble'), `read-only drops it: ${look[0].tools}`);
    assert.ok(look.at(-1)!.results.some(r => r.includes('sandboxed')), `ran through OptChat's bash: ${look.at(-1)!.results}`);
    assert.ok(!existsSync(marker), 'the extension\'s bash never ran');
  } finally { rmSync(file, { force: true }); await children.close(); removeDir(dir); }
});

test('on macOS a read-only child\'s bash cannot write outside temp directories', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  // The harness directory is under TMPDIR, which the sandbox lets through; the probe goes in the repository instead.
  const dir = mkdtempSync(join(tmpdir(), 'optchat-readonly-mac-')), probe = join(process.cwd(), `.readonly-probe-${randomUUID()}`), { children, asked } = await harness(dir);
  try {
    const task = `RUN: touch '${probe}'`;
    await children.spawn([{ task, tools: 'readonly' }], dir);
    await until(() => !children.active);
    assert.ok(!existsSync(probe), 'the file was not created');
    assert.match(asked.filter(a => a.task === task).at(-1)!.results.join('\n'), /Operation not permitted/);
  } finally { rmSync(probe, { force: true }); await children.close(); removeDir(dir); }
});

test('with memory off a child gets only its task: no view, no zoom or date, no view doc', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-no-memory-')), { children, asked } = await harness(dir);
  try {
    await children.spawn([{ task: 'blind', memory: false }, { task: 'sighted' }], dir);
    await until(() => !children.active);
    const blind = asked.find(a => a.task === 'blind')!, sighted = asked.find(a => a.task === 'sighted')!;
    assert.equal(blind.first, 'Your task:\nblind');
    assert.notEqual(sighted.first, 'Your task:\nsighted', 'with memory the view comes first');
    assert.ok(!blind.tools.includes('zoom') && !blind.tools.includes('date'));
    assert.ok(sighted.tools.includes('zoom') && sighted.tools.includes('date'));
    assert.match(blind.system, /You do not see OptChat's memory/);
    assert.doesNotMatch(blind.system, /zoom/);
  } finally { await children.close(); removeDir(dir); }
});

test('role, tools and memory are saved with the run and kept when tell resumes it; older run files without them still load', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-options-resume-')), { children, asked } = await harness(dir, ROLES);
  try {
    const [id] = await children.spawn([{ task: 'remember me', role: 'looker' }], dir);
    await until(() => !children.active);
    const run = children.history.records.get(id)!;
    assert.deepEqual([run.role, run.tools, run.memory, run.model, run.thinking], ['looker', 'readonly', false, 'optchat-test/deep', 'low']);
    const reloaded = new RunHistory(join(dir, 'profile')).records.get(id)!;
    assert.deepEqual([reloaded.role, reloaded.tools, reloaded.memory], ['looker', 'readonly', false]);
    await children.tell(id, 'Again.');
    await until(() => !children.active);
    const again = asked.at(-1)!;
    assert.equal(again.task, 'remember me');
    assert.ok(!again.tools.includes('edit') && !again.tools.includes('zoom'), 'still read-only and without memory');
    assert.equal(again.reasoning, 'low');
    // A run saved by an older version has none of the new fields.
    const old = { id: 'old00001', task: 't', cwd: dir, model: 'optchat-test/child', thinking: 'off', parentSession: '', depth: 1, started: 1, ended: 2, state: 'completed', guidance: [] };
    writeFileSync(join(dir, 'profile', 'runs', 'old00001.optchat.json'), JSON.stringify(old));
    writeFileSync(join(dir, 'profile', 'runs', 'bad00001.optchat.json'), JSON.stringify({ ...old, id: 'bad00001', tools: 'some' }));
    const history = new RunHistory(join(dir, 'profile'));
    assert.ok(history.records.has('old00001'));
    assert.ok(!history.records.has('bad00001'));
    assert.match(history.warnings.join('\n'), /bad00001/);
  } finally { await children.close(); removeDir(dir); }
});

test('isolation worktree: changes are committed on optchat/<id> and the worktree removed; without changes both go; outside a repo the spawn fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-worktree-')), path = repo(dir), { children, reports } = await harness(dir);
  try {
    const [changer, idle, nested] = await children.spawn([{ task: 'RUN: echo made > made.txt', cwd: path, isolation: 'worktree' }, { task: 'nothing', cwd: path, isolation: 'worktree' },
      { task: 'RUN: pwd > where.txt', cwd: join(path, 'sub'), isolation: 'worktree' }], dir);
    const running = children.history.records.get(changer)!;
    assert.equal(running.worktree?.branch, `optchat/${changer}`);
    assert.equal(running.worktree?.path, worktreePath(changer));
    assert.ok(!running.worktree!.path.startsWith(path), 'the worktree lives outside the repository');
    assert.equal(realpathSync(children.history.records.get(nested)!.cwd), realpathSync(join(worktreePath(nested), 'sub')), 'a task started in a subdirectory starts there in its worktree');
    await until(() => !children.active);
    assert.ok(!existsSync(worktreePath(changer)) && !existsSync(worktreePath(idle)) && !existsSync(worktreePath(nested)));
    assert.deepEqual(branches(path), ['main', `optchat/${changer}`, `optchat/${nested}`].sort());
    assert.equal(git(path, 'show', `optchat/${changer}:made.txt`), 'made');
    assert.match(git(path, 'show', `optchat/${nested}:sub/where.txt`), new RegExp(`worktrees/${nested}/sub$`));
    assert.ok(!existsSync(join(path, 'made.txt')), 'the main checkout is untouched');
    assert.equal(git(path, 'status', '--porcelain'), '');
    assert.equal(git(path, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length, 1);
    const report = (id: string) => reports.find(r => r.startsWith(`[${id}]`)) ?? '';
    assert.match(report(changer), new RegExp(`changes are on branch optchat/${changer} in .* \\(1 commit past`));
    assert.match(report(idle), new RegExp(`changed no files, so its worktree and branch optchat/${idle} were removed`));
    await assert.rejects(children.spawn([{ task: 'fine', cwd: path, isolation: 'worktree' }, { task: 'x', cwd: dir, isolation: 'worktree' }], dir),
      /Task 2: isolation "worktree" needs a git repository, and .* is not inside one\./);
    assert.equal(children.history.records.size, 3, 'the refused spawn started nothing');
    assert.deepEqual(branches(path), ['main', `optchat/${changer}`, `optchat/${nested}`].sort(), 'and made no branch');
  } finally { await children.close(); removeDir(dir); }
});

test('tell brings a finished isolated run\'s worktree back on its branch, and its new changes land there too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-worktree-tell-')), path = repo(dir), { children, reports } = await harness(dir);
  try {
    const [id] = await children.spawn([{ task: 'RUN: echo one > one.txt', cwd: path, isolation: 'worktree' }], dir);
    await until(() => !children.active);
    await children.tell(id, 'RUN: echo two > two.txt');
    assert.ok(existsSync(worktreePath(id)) || !children.active);
    await until(() => !children.active);
    assert.equal(git(path, 'rev-list', '--count', `main..optchat/${id}`), '2');
    assert.equal(git(path, 'show', `optchat/${id}:one.txt`), 'one');
    assert.equal(git(path, 'show', `optchat/${id}:two.txt`), 'two');
    assert.ok(!existsSync(worktreePath(id)));
    assert.match(reports.at(-1)!, /2 commits past/);
  } finally { await children.close(); removeDir(dir); }
});

test('a cwd that is untracked in the repository fails the spawn up front and leaves no worktree or branch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-worktree-untracked-')), path = repo(dir), { children } = await harness(dir);
  try {
    mkdirSync(join(path, 'scratch')); writeFileSync(join(path, 'scratch', 'notes.txt'), 'local\n');
    await assert.rejects(children.spawn([{ task: 'x', cwd: join(path, 'scratch'), isolation: 'worktree' }], dir),
      /Task 1: .*scratch is not in the last commit of its repository \(it is untracked or ignored\)/);
    assert.deepEqual(branches(path), ['main']);
    assert.equal(git(path, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length, 1);
    assert.equal(children.history.records.size, 0);
  } finally { await children.close(); removeDir(dir); }
});

test('a resume that fails after its worktree came back removes the worktree again and keeps the branch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-worktree-resume-fail-')), path = repo(dir), { children, control } = await harness(dir);
  try {
    const [id] = await children.spawn([{ task: 'RUN: echo one > one.txt', cwd: path, isolation: 'worktree' }], dir);
    await until(() => !children.active);
    control.failOpen = true;
    await assert.rejects(children.tell(id, 'Again.'), /session failed to open/);
    assert.ok(!existsSync(worktreePath(id)), 'the reopened worktree is gone');
    assert.equal(git(path, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length, 1);
    assert.equal(git(path, 'show', `optchat/${id}:one.txt`), 'one', 'the branch and its work stay');
    control.failOpen = false;
    await children.tell(id, 'RUN: echo two > two.txt');
    await until(() => !children.active);
    assert.equal(git(path, 'show', `optchat/${id}:two.txt`), 'two', 'and a later resume still works');
  } finally { await children.close(); removeDir(dir); }
});

test('deleting a working worktree run still says which branch its changes are on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-worktree-delete-')), path = repo(dir), { children, asked, reports } = await harness(dir);
  try {
    const [id] = await children.spawn([{ task: 'HOLD', cwd: path, isolation: 'worktree' }], dir);
    await until(() => asked.length > 0);
    writeFileSync(join(worktreePath(id), 'partial.txt'), 'half\n');
    await children.remove(id);
    const report = reports.find(r => r.startsWith(`[${id}]`)) ?? '';
    assert.match(report, /Deleted by the user while it was working/);
    assert.match(report, new RegExp(`changes are on branch optchat/${id} in `));
    assert.equal(git(path, 'show', `optchat/${id}:partial.txt`), 'half');
  } finally { await children.close(); removeDir(dir); }
});

test('a worktree run cut off by Pi closing keeps its worktree, and the next start resumes it there', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-worktree-cut-')), path = repo(dir), first = await harness(dir);
  const [id] = await first.children.spawn([{ task: 'HOLD', cwd: path, isolation: 'worktree' }], dir);
  try {
    await until(() => first.asked.length > 0);
    writeFileSync(join(worktreePath(id), 'partial.txt'), 'half done\n');
    await first.children.close();
    const cut = first.children.history.records.get(id)!;
    assert.equal(cut.state, 'interrupted'); assert.equal(cut.cutOff, true);
    assert.ok(existsSync(join(worktreePath(id), 'partial.txt')), 'the worktree and its uncommitted work survive the close');
    const second = first.make();
    // HOLD again would wait forever: the resumed run's first message is the restart note, but the task stays HOLD, so stop it once it asks.
    await second.resumeCutOff();
    assert.equal(second.history.records.get(id)!.worktree?.path, worktreePath(id));
    await until(() => first.asked.length > 1);
    assert.equal(realpathSync(second.history.records.get(id)!.cwd), realpathSync(worktreePath(id)));
    await second.stop(id);
    await until(() => !second.active);
    assert.equal(git(path, 'show', `optchat/${id}:partial.txt`), 'half done', 'a user stop still commits what is there');
    assert.ok(!existsSync(worktreePath(id)));
    assert.ok(readFileSync(join(dir, 'profile', 'runs', `${id}.optchat.json`), 'utf8').includes(`optchat/${id}`));
    await second.close();
  } finally { removeDir(dir); }
});
