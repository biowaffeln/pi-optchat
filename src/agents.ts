import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, getAgentDir, type AgentSession, type AgentSessionEvent, type ExtensionAPI, type InlineExtension, type ModelRegistry } from '@earendil-works/pi-coding-agent';
import * as sdk from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { StringEnum, type Api, type Model } from '@earendil-works/pi-ai';
import { allowSearch, cutOffChildren, delegation, NO_DELEGATION, READ_ONLY, RESTARTED, SEARCH_DOC, STEERABLE, SUBAGENT, SUBAGENT_NO_MEMORY, TELL_PARENT, VIEW_DOC, worktreeDoc } from './prompts.ts';
import { DEFAULT_ROLES, TOOL_SETS, type Roles, type ToolSet } from './roles.ts';
import { createWorktree, discardWorktree, finishWorktree, reopenWorktree, repoOf, workingDirectory, type Worktree } from './worktree.ts';
import { memoryTools, searchTool } from './tools.ts';
import { VIEW, type Kind, type Memory } from './memory.ts';
import type { ModelChoice } from './compactor.ts';
import { cachePayload } from './cache.ts';
import { CUT_OFF, RunHistory, isRunning, transition, sessionMessages, type RunInfo, type RunState } from './runs.ts';
import { UsageLedger } from './usage.ts';
import { fullChat, refreshFraction, textContent } from './transcript.ts';
import { Type, type Static } from 'typebox';
import { result } from './tools.ts';
import { DEFAULT_SETTINGS, type Settings } from './settings.ts';
import { THINKING } from './profiles.ts';

export interface LiveRun {
  session: AgentSession; info: RunInfo; updated: number; streaming?: AgentMessage;
  tools: Map<string, { name: string; args: unknown; output?: unknown; started: number }>;
  pendingReports: string[]; pendingGuidance: string[]; wake?: () => void; completion?: Promise<void>; primed?: Promise<unknown>;
  /** Set by the user's interrupt: the queued guidance the run continues with once its current step is aborted; with none, it pauses. */
  interruption?: RunInfo['guidance'];
  /** Messages being steered back into Pi's queue after it was cleared; other queue changes wait for it. */
  requeueing?: Promise<void>;
  /** Shared by the children of one spawn whose reports are delivered together, in spawn order. */
  batch?: { ids: string[]; reports: Map<string, string> };
  /** Why stop() ended it; the first stop wins. */
  stoppedBy?: StopCause;
}
/** `parent`: the agent that started it was stopped, or ended while it still worked. `pi`: Pi closed or reloaded while it was paused (working runs are cut off and resumed instead); a paused child whose parent still works gets `parent`, since close() stops that parent, which marks its descendants first. */
type StopCause = 'user' | 'parent' | 'pi';
// Said plainly: the aborted request's own error names no cause and reads as a failure.
const STOPPED: Record<StopCause, string> = {
  user: 'Stopped by the user. They ended it on purpose, so it did not fail: do not redo or delegate this task again unless they ask. Its chat is kept, so tell resumes it where it stopped.',
  parent: 'Stopped because the agent that started it stopped or ended. Its chat is kept, so tell resumes it where it stopped.',
  pi: 'Stopped because Pi closed or reloaded while it waited for the user. It is not resumed on its own; its chat is kept, so tell resumes it where it stopped.',
};
const stoppedReport = (cause: StopCause, text = '') => `${STOPPED[cause]}${text ? `\n\nIts last message before the stop:\n${text}` : ''}`;
interface Options { parentSession?: string; usage?: UsageLedger; createSession?: typeof createAgentSession;
  /** Names of the built-in extensions the main session loaded (see `loadedBuiltins`). */
  builtins?: () => Iterable<string>;
  /** Journals the reports a main-agent spawn has so far while its other children still run (none: the batch was delivered), so a crash cannot lose them. */
  hold?: (batch: string, texts: string[]) => void;
  /** Read on every spawn, so a changed profile setting applies to the next one. Missing settings take their defaults. */
  settings?: () => Partial<Settings>;
  /** The roles a task may name; the built-in ones when unset. */
  roles?: () => Roles }

// Subagents load the user's installed extensions, except any copy of OptChat itself: they get memory tools directly and must not open a profile.
const packageName = (path: string): string | undefined => {
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const data: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      return data && typeof data === 'object' && 'name' in data && typeof data.name === 'string' ? data.name : undefined;
    } catch { return undefined; } // A broken manifest is not OptChat's and must not block every spawn.
  }
};
/** A task's cwd may start with `~` and may be relative to the spawning agent's directory. */
export const taskDirectory = (cwd: string, path = '.', windows = process.platform === 'win32') =>
  resolve(cwd, path.replace(windows ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/, homedir()));
const CWD_DOC = 'Project directory the subagent works in (~ allowed); its AGENTS.md files load from there. Defaults to your current directory.';
/** The spawn tools' tasks. What a task leaves out of model and thinking is the profile's subagent choice. */
export const TASKS = Type.Array(Type.Object({ task: Type.String(), cwd: Type.Optional(Type.String({ description: CWD_DOC })),
  role: Type.Optional(Type.String({ description: 'A role from your instructions (scout, reviewer, ...): presets model, thinking, tools and memory for the task. Pick one freely when it fits; fields set on the task override it.' })),
  model: Type.Optional(Type.String({ description: 'Leave unset for the role\'s or the profile\'s subagent model (named in your instructions). Set only when the user asks for a model, as provider/id from models().' })),
  thinking: Type.Optional(StringEnum(THINKING, { description: 'Leave unset for the role\'s or the profile\'s subagent level. Set only when the user asks for one.' })),
  tools: Type.Optional(StringEnum(TOOL_SETS, { description: '"all" (default) or "readonly": no edit or write tools. Bash stays, so read-only is a rule the subagent is asked to keep, not a sandbox; extension tools stay too.' })),
  memory: Type.Optional(Type.Boolean({ description: 'Default true: the subagent gets the memory view and zoom/date. false: only your task text (plus AGENTS.md and skills), so write a complete brief.' })),
  isolation: Type.Optional(StringEnum(['worktree'] as const, { description: '"worktree": the subagent works in its own git worktree on a new branch optchat/<id> from the HEAD of the repo holding cwd. On finish, its changes are committed on that branch (named in its report); with none, worktree and branch are removed.' })) }), { minItems: 1 });
export type Task = Static<typeof TASKS>[number];
/** A task with its role, model and options resolved: task fields win over the role, the role over the profile's defaults. */
interface Resolved { task: string; cwd?: string; model: Model<Api>; thinking: ModelChoice['thinking']; role?: string; tools: ToolSet; memory: boolean; isolation?: 'worktree' }
/** What open() builds a child session with, new or resumed. */
interface ChildOptions { tools: ToolSet; memory: boolean; worktree?: Worktree }
/** The tool beside spawn that lists what a task's `model` may be. */
export const modelsTool = (children: () => Children) => ({ name: 'models', label: 'List models',
  description: 'The models a spawn task may name, as provider/id, with the profile\'s subagent default marked. provider narrows the list to one provider.',
  parameters: Type.Object({ provider: Type.Optional(Type.String()) }),
  execute: async (_id: string, args: { provider?: string }) => result(children().models(args.provider)) });
const isOptchat = (path: string) => packageName(path) === 'pi-optchat';
/** Pi's built-in tools that change files, left out of a read-only child; bash stays (see READ_ONLY in prompts.ts). */
export const READ_ONLY_EXCLUDED = ['edit', 'write'];
const READ_ONLY_ADDED = ['read', 'grep', 'find', 'ls'];

// Pi's CLI adds its built-in extensions (MCP, codemode, tool search) to its own session; SDK sessions such as
// subagents must add them. Pi versions that do not export a factory simply do not get that extension.
const BUILTINS: Record<string, string> = { mcp: 'createMcpExtension', codemode: 'createCodemodeExtension', 'tool-search': 'createToolSearchExtension' };
const PREFIX = 'builtin:';
/** The built-in extensions a session loaded: `--no-mcp`, `-builtin:<name>` settings and replacing extensions leave them out. */
export const loadedBuiltins = (pi: Pick<ExtensionAPI, 'getCommands' | 'getAllTools'>) => new Set([...pi.getCommands(), ...pi.getAllTools()]
  .map(item => item.sourceInfo?.path ?? '').filter(path => path.startsWith(PREFIX) && Object.hasOwn(BUILTINS, path.slice(PREFIX.length))).map(path => path.slice(PREFIX.length)));
/** Fresh built-in extensions for one session, as `builtin:<name>` resources, so the session's own settings still apply. */
export const builtinExtensions = (names: Iterable<string>): InlineExtension[] => [...new Set(names)].flatMap(name => {
  const create = Object.hasOwn(BUILTINS, name) ? (sdk as unknown as Record<string, unknown>)[BUILTINS[name]] : undefined;
  return typeof create === 'function' ? [{ name, factory: create(), replaceable: true, builtin: true }] : [];
});
/** Subagent transcripts are never summarized into the memory tree, so the mid-turn view refresh can't cover them; we rely on
 * Pi's built-in compaction instead, set to start at about the main agent's Turn refresh threshold: that share of the window on top of the
 * view in the task. If subagent quality drops after compaction, look into giving subagents their own summary tree (same refresh
 * as the main agent) or a hybrid: Pi compaction plus a zoomable summarized transcript. With the threshold off, Pi's default applies. */
export function subagentCompaction(contextWindow: number, fraction: number) {
  if (!(fraction > 0)) return { enabled: true };
  return { enabled: true, reserveTokens: Math.max(16_384, Math.round(contextWindow * (1 - fraction) - VIEW / 4)) };
}
/** Waits for `promise`, or until `signal` aborts. */
async function abortable(promise: Promise<unknown>, signal?: AbortSignal) {
  let stop = () => {};
  const aborted = new Promise<void>(resolve => { stop = resolve; });
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  try { await Promise.race([promise, aborted]); } finally { signal?.removeEventListener('abort', stop); }
}
/** Resolves once the session's model starts answering, or its request ends without an answer. */
const answering = (session: AgentSession) => new Promise<void>(resolve => {
  const off = session.subscribe(event => {
    if (event.type === 'message_update' || event.type === 'agent_end' || event.type === 'message_end' && event.message.role === 'assistant') { off(); resolve(); }
  });
});

/** What a run interrupted with messages queued continues with: the user's interrupt, so the agent view shows it as theirs. */
export const INTERRUPTED = 'Interrupted by the user:\n\n';
const interruptedWith = (texts: string[]) => `${INTERRUPTED}${texts.join('\n\n')}`;

/** Pi reads AGENTS.md/CLAUDE.md only at session start and /reload. Re-reading the files Pi loaded picks up edits each run and keeps
 * the session's own choices (`-nc`, its agent dir); a file that can't be read is skipped, as Pi does. A new file still needs /reload. */
export function refreshContextFiles(options: { contextFiles: Array<{ path: string; content: string }> }) {
  options.contextFiles = options.contextFiles.flatMap(({ path }) => { try { return [{ path, content: readFileSync(path, 'utf8') }]; } catch { return []; } });
}
export class Children {
  private readonly running = new Map<string, LiveRun>();
  readonly history: RunHistory;
  private readonly listeners = new Set<() => void>();
  private closing = false;
  private launching = 0;
  private readonly resuming = new Set<string>();
  private readonly deleting = new Set<string>();
  private settling = 0;
  private readonly launches = new Set<Promise<unknown>>();
  private readonly completions = new Set<Promise<void>>();
  /** The branch's memory. A rebase replaces it; a run keeps reading the one it started with, whose ids its view uses. */
  private current: Memory;
  /** Lines logged while a rebase has closed the old memory and not yet opened the new one. */
  private held: [Kind, string][] = [];
  get memory() { return this.current; }
  set memory(memory: Memory) {
    this.current = memory;
    for (const [kind, text] of this.held.splice(0)) memory.append(kind, text);
  }
  private log(kind: Kind, text: string) {
    if (this.current.closed) this.held.push([kind, text]); else this.current.append(kind, text);
  }
  constructor(memory: Memory, private readonly registry: ModelRegistry,
    private readonly choice: () => ModelChoice, private readonly instructions: () => string,
    private readonly report: (text: string, options?: { once?: boolean; count?: number }) => Promise<void>, private readonly warn: (text: string) => void,
    private readonly profileDirectory = memory.directory, private readonly options: Options = {}) {
    this.current = memory;
    this.history = new RunHistory(profileDirectory);
    for (const warning of this.history.warnings) warn(warning);
    for (const run of this.history.records.values()) {
      if (!run.sessionFile || !options.usage) continue;
      try {
        const manager = SessionManager.open(run.sessionFile);
        options.usage.backfill(manager.getEntries(), run.parentSession, 'subagent', run.id);
      } catch (error) { warn(`Could not backfill child usage for ${run.id}: ${String(error)}`); }
    }
  }
  private get settings(): Settings { return { ...DEFAULT_SETTINGS, ...this.options.settings?.() }; }
  get roles(): Roles { return this.options.roles?.() ?? DEFAULT_ROLES; }
  /**
   * Each task's model, thinking, tools and memory: what the task sets, else its role's, else the profile's subagent choice
   * (tools all, memory on). A read-only parent's children are read-only too, so delegating can't get around it.
   */
  resolve(tasks: Task[], parentTools?: ToolSet): Resolved[] {
    const profile = this.choice(), roles = this.roles;
    return tasks.map((task, i) => {
      const role = task.role === undefined ? undefined : roles[task.role];
      if (task.role !== undefined && !role) throw new Error(`Task ${i + 1}: no role ${task.role}. Roles: ${Object.keys(roles).join(', ') || 'none (this profile\'s config.json sets an empty roles object)'}.`);
      const named = task.model ?? role?.model, name = named ?? `${profile.provider}/${profile.model}`, model = this.find(name);
      // Like Pi's own setModel: a named model needs auth, so a guess at a provider the user isn't logged in to fails here, not in the child.
      // A role's model is never swapped for another: the role was picked for it.
      if (!model || named && !this.registry.hasConfiguredAuth(model)) throw new Error(`${task.model === undefined && role?.model ? `Task ${i + 1}: role ${task.role}'s model is unavailable: ${name}. Pick another role or name a model. ` : `Subagent model unavailable: ${name}. `}Models you can use: ${this.registry.getAvailable().map(m => `${m.provider}/${m.id}`).join(', ') || 'none'}.`);
      const tools = parentTools === 'readonly' ? 'readonly' : task.tools ?? role?.tools ?? 'all';
      return { task: task.task, cwd: task.cwd, model, thinking: task.thinking ?? role?.thinking ?? profile.thinking, role: task.role, tools,
        memory: task.memory ?? role?.memory ?? true, isolation: task.isolation };
    });
  }
  private full(extra: number) { return this.running.size + this.launching + extra > this.settings.maxAgents; }
  /** A model named `provider/id`, as runs record it. */
  /** The models a task may name, one `provider/id` per line: every model Pi is logged in to, the profile's subagent choice marked. */
  models(provider?: string) {
    const profile = this.choice(), fallback = `${profile.provider}/${profile.model}`;
    const available = this.registry.getAvailable();
    const names = available.filter(m => !provider || m.provider === provider).map(m => `${m.provider}/${m.id}`).sort();
    if (!names.length) throw new Error(provider ? `No models for provider ${provider}. Providers: ${[...new Set(available.map(m => m.provider))].sort().join(', ') || 'none'}.` : 'No models available.');
    return names.map(name => name === fallback ? `${name}  (subagent default, thinking ${profile.thinking})` : name).join('\n');
  }
  private find(name: string) { const slash = name.indexOf('/'); return slash > 0 ? this.registry.find(name.slice(0, slash), name.slice(slash + 1)) : undefined; }
  get ids() { return [...this.running.keys()]; }
  get active() { return this.completions.size > 0 || this.launching > 0 || this.settling > 0; }
  live(id: string) { return this.running.get(id); }
  collectUsage() {
    for (const live of this.running.values()) this.options.usage?.backfill(live.session.sessionManager.getEntries(), live.info.parentSession, 'subagent', live.info.id);
  }
  messages(id: string): AgentMessage[] {
    const live = this.running.get(id);
    if (live) return [...live.session.messages, ...(live.streaming ? [live.streaming] : [])];
    const file = this.history.records.get(id)?.sessionFile;
    return file ? sessionMessages(file) : [];
  }
  /**
   * Every message a run has finalized, in order and never rewritten: Pi's session entries, for a live run too.
   * `session.messages` is only the model's projection, which compaction and retries replace with a shorter list.
   */
  retained(id: string): AgentMessage[] {
    const live = this.running.get(id);
    return live ? live.session.sessionManager.getEntries().flatMap(e => e.type === 'message' ? [e.message] : []) : this.messages(id);
  }
  /** A run's messages for zoom, live or finished; undefined for no such run. A subagent `reader` sees only its own descendants, as with tell. */
  transcript(id: string, reader?: string) {
    const known = reader ? this.history.descendants(reader).some(run => run.id === id) : this.running.has(id) || this.history.records.has(id);
    if (!known) return undefined;
    const live = this.running.get(id);
    if (!live) return this.messages(id);
    const retained = this.retained(id);
    // Pi puts the finalized message in session.messages before message_end listeners run, then persists that same object.
    const tail = live.streaming ?? live.session.messages.at(-1);
    return tail && !retained.includes(tail) ? [...retained, tail] : retained;
  }
  /** Runs at work now: running, waiting for children, or stopping; not paused. */
  get working() { return [...this.running.values()].filter(live => isRunning(live.info)).map(live => live.info); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  private save(info: RunInfo) { this.history.save(info); this.changed(); }
  private observe(live: LiveRun, event: AgentSessionEvent) {
    try {
      live.updated = Date.now();
      if (event.type === 'message_update') live.streaming = event.message;
      if (event.type === 'message_end') {
        live.streaming = undefined;
      }
      if (event.type === 'turn_end' || event.type === 'agent_settled') this.options.usage?.backfill(live.session.sessionManager.getEntries(), live.info.parentSession, 'subagent', live.info.id);
      if (event.type === 'message_start' && event.message.role === 'user') {
        const text = textContent(event.message.content);
        const guidance = live.info.guidance.find(g => g.state === 'queued' && g.text === text);
        if (guidance) { guidance.state = 'delivered'; this.save(live.info); }
      }
      if (event.type === 'tool_execution_start') live.tools.set(event.toolCallId, { name: event.toolName, args: event.args, started: Date.now() });
      if (event.type === 'tool_execution_update') {
        const tool = live.tools.get(event.toolCallId); if (tool) tool.output = event.partialResult;
      }
      if (event.type === 'tool_execution_end') live.tools.delete(event.toolCallId);
      this.changed();
    } catch (error) { this.warn(`Could not record subagent activity: ${String(error)}`); }
  }
  async spawn(tasks: Task[], cwd: string, signal?: AbortSignal, parentId?: string) {
    return (await this.launch(tasks, cwd, signal, parentId)).ids;
  }
  /** The spawn tools' answer, saying how this spawn's reports will come back. */
  async start(tasks: Task[], cwd: string, signal?: AbortSignal, parentId?: string) {
    const { ids, grouped } = await this.launch(tasks, cwd, signal, parentId);
    return `Started: ${ids.join(', ')}. ${grouped && ids.length > 1 ? 'Their reports will arrive together, as one message, once all of them have finished.' : 'Reports will arrive automatically.'}`;
  }
  private async launch(tasks: Task[], cwd: string, signal: AbortSignal | undefined, parentId: string | undefined) {
    for (const directory of tasks.map(t => taskDirectory(cwd, t.cwd))) if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error(`No such directory: ${directory}`);
    const runs = this.resolve(tasks, parentId ? this.running.get(parentId)?.info.tools : undefined);
    // Checked before anything starts, so a task outside a repository fails the spawn rather than running unisolated.
    await Promise.all(runs.map(async (run, i) => {
      if (run.isolation !== 'worktree') return;
      try { await repoOf(taskDirectory(cwd, run.cwd)); }
      catch (error) { throw new Error(`Task ${i + 1}: ${error instanceof Error ? error.message : String(error)}`); }
    }));
    if (this.closing) throw new Error('Profile is closing.');
    this.settling++;
    try { await this.memory.settle(signal); } finally { this.settling--; }
    const parent = parentId ? this.running.get(parentId) : undefined;
    const cancelled = () => this.closing || (parentId !== undefined && this.running.get(parentId)?.info.state !== 'running');
    if (parentId && (!parent || parent.info.state !== 'running')) throw new Error('The parent is no longer running.');
    const depth = parent ? parent.info.depth + 1 : 1;
    const { subagentLevels, maxAgents, groupReports } = this.settings;
    if (depth > subagentLevels) throw new Error(`Delegation depth limit reached: this profile allows ${subagentLevels} level${subagentLevels === 1 ? '' : 's'} of subagents.`);
    if (this.closing) throw new Error('Profile is closing.');
    if (this.full(tasks.length)) throw new Error(`Profile limit: at most ${maxAgents} active agents, including parents and descendants. Reduce the batch or continue without delegating.`);
    const view = this.memory.render();
    const launched = await this.track(this.launchBatch({ tasks: runs, cwd, depth, parentId, signal, cancelled }));
    // Grouped, the last child of this spawn to finish delivers every report; otherwise each reports on its own.
    const batch = groupReports ? { ids: launched.map(c => c.info.id), reports: new Map<string, string>() } : undefined;
    // Siblings on one model and directory send the same system prompt, tools and view. Anthropic can't read a cache entry
    // still being written, so their first requests wait until the first sibling starts answering and read its entry instead.
    const [first] = launched, answered = launched.length > 1 && first.session.model?.api === 'anthropic-messages' ? answering(first.session) : undefined;
    for (const live of launched) {
      live.batch = batch;
      const work = this.execute(live, live.info.memory === false ? `Your task:\n${live.info.task}` : `${view}\n\nYour task:\n${live.info.task}`).catch(error => this.warn(`Subagent completion failed: ${String(error)}`))
        .finally(() => { this.completions.delete(work); this.changed(); });
      if (live === first && answered) for (const sibling of launched.slice(1)) if ((['model', 'thinking', 'cwd', 'tools', 'memory'] as const).every(k => sibling.info[k] === first.info[k])) sibling.primed = Promise.race([answered, work]);
      this.completions.add(work);
      live.completion = work;
    }
    this.changed();
    return { ids: launched.map(c => c.info.id), grouped: batch !== undefined };
  }
  /** close() waits for launches, so shutdown never unlocks the profile under a child that is still opening. */
  private track<T>(launch: Promise<T>) {
    this.launches.add(launch);
    const done = () => { this.launches.delete(launch); };
    launch.then(done, done);
    return launch;
  }
  private async launchBatch({ tasks, cwd, depth, parentId, signal, cancelled }: { tasks: Resolved[]; cwd: string; depth: number;
    parentId?: string; signal?: AbortSignal; cancelled: () => boolean }) {
    const launched: LiveRun[] = [];
    let reserved = tasks.length;
    this.launching += reserved;
    try {
      for (const task of tasks) {
        signal?.throwIfAborted();
        if (cancelled()) throw new Error('Parent or profile is stopping.');
        const id = randomUUID().slice(0, 8), asked = taskDirectory(cwd, task.cwd);
        const worktree = task.isolation === 'worktree' ? await createWorktree(asked, id) : undefined;
        const directory = worktree ? workingDirectory(worktree, asked) : asked;
        let session: AgentSession;
        try {
          session = await this.open({ id, directory, depth, parentId, model: task.model, thinking: task.thinking, tools: task.tools, memory: task.memory, worktree,
            sessionManager: SessionManager.create(directory, join(this.profileDirectory, 'runs')) });
        } catch (error) { if (worktree) await discardWorktree(worktree); throw error; }
        const info: RunInfo = { id, task: task.task, cwd: directory, model: `${task.model.provider}/${task.model.id}`, thinking: session.thinkingLevel,
          parentSession: this.options.parentSession ?? '', parentId, depth, sessionFile: session.sessionFile, started: Date.now(), state: 'running', guidance: [],
          ...task.role !== undefined && { role: task.role }, tools: task.tools, memory: task.memory, ...worktree && { worktree } };
        const live: LiveRun = { session, info, updated: Date.now(), tools: new Map(), pendingReports: [], pendingGuidance: [] };
        launched.push(live); this.save(info); this.running.set(id, live);
        this.launching--; reserved--;
        session.subscribe(event => this.observe(live, event));
        signal?.throwIfAborted();
        if (cancelled()) throw new Error('Parent or profile is stopping.');
      }
    } catch (error) {
      for (const child of launched) {
        await this.shutdown(child.session); // Extensions such as MCP close their connections and stop their server processes.
        this.dispose(child.session); this.running.delete(child.info.id);
        if (child.info.worktree) await discardWorktree(child.info.worktree);
        transition(child.info, 'failed'); child.info.ended = Date.now(); child.info.report = `Launch failed: ${String(error)}`;
        this.save(child.info);
      }
      throw error;
    } finally { this.launching -= reserved; }
    return launched;
  }
  /** Builds a child session with the same prompt, tools and extensions whether it is new or resumed. */
  private async open(o: { id: string; directory: string; depth: number; parentId?: string; model: Model<Api>;
    thinking?: ModelChoice['thinking']; sessionManager: SessionManager } & ChildOptions) {
    const { id, directory, depth, parentId } = o, memory = this.memory, readonly = o.tools === 'readonly';
    const { subagentLevels, maxAgents, memorySearch } = this.settings, delegates = depth < subagentLevels;
    // The user's settings list their installed packages; a copy in memory keeps the child from writing them back.
    const settingsManager = SettingsManager.inMemory({ ...SettingsManager.create(directory, getAgentDir()).getSettings(),
      compaction: subagentCompaction(o.model.contextWindow, refreshFraction(this.settings.refreshAt)), cacheWarming: 'off' });
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: getAgentDir(), settingsManager,
      noPromptTemplates: true,
      extensionsOverride: base => ({ ...base, extensions: base.extensions.filter(e => !isOptchat(e.resolvedPath)) }),
      extensionFactories: [...builtinExtensions(this.options.builtins?.() ?? []), pi => {
        const provider = this.registry.getRegisteredProviderConfig(o.model.provider);
        if (provider) pi.registerProvider(o.model.provider, provider);
        // Same prompt as the main agent (AGENTS.md files, skills, cwd); only the OptChat preamble differs.
        // Read every run, so edits reach a live child's next run (after a pause, say); Pi sends only the changed sections.
        pi.on('before_agent_start', event => {
          event.systemPromptOptions.customPrompt = o.memory ? allowSearch(`${SUBAGENT}\n\n${VIEW_DOC}${memorySearch ? SEARCH_DOC : ''}`, memorySearch) : SUBAGENT_NO_MEMORY;
          event.systemPromptOptions.sections.instructions = [this.instructions(), delegates ? delegation(maxAgents, this.choice(), this.roles) : NO_DELEGATION, STEERABLE, TELL_PARENT,
            readonly ? READ_ONLY : '', o.worktree ? worktreeDoc(o.worktree.branch, o.worktree.repo) : ''].filter(Boolean).join('\n\n');
          refreshContextFiles(event.systemPromptOptions);
        });
        pi.on('before_provider_request', async (event, ctx) => {
          // Set by launch for a sibling's first request; a stop or an interrupt aborts the request, which ends the wait.
          const live = this.running.get(id), primed = live?.primed;
          if (live && primed) { live.primed = undefined; await abortable(primed, ctx.signal); }
          return ctx.model?.api === 'anthropic-messages' ? cachePayload(event.payload) : event.payload;
        });
      }],
    });
    await loader.reload();
    const { session } = await (this.options.createSession ?? createAgentSession)({ cwd: directory, resourceLoader: loader, settingsManager,
      model: o.model, thinkingLevel: o.thinking, sessionManager: o.sessionManager,
      customTools: [...(o.memory ? memoryTools(() => memory, run => this.transcript(run, id)) : []), ...(o.memory && memorySearch ? [searchTool(() => memory)] : []), ...(delegates ? [...this.delegationTools(id, directory, subagentLevels, maxAgents), modelsTool(() => this)] : []), this.parentTool(id, parentId)],
      excludeTools: [...delegates ? [] : ['spawn', 'tell', 'models'], ...readonly ? READ_ONLY_EXCLUDED : []],
    });
    // Callers track the session only after this returns: clean up here if its extensions fail to start.
    try {
      await session.bindExtensions({});
      // Pi's default tools are read, bash, edit and write; a read-only child trades edit and write for Pi's read-only search tools.
      if (readonly) session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), ...READ_ONLY_ADDED])]);
    }
    catch (error) { await this.shutdown(session); this.dispose(session); throw error; }
    return session;
  }
  private delegationTools(parentId: string, cwd: string, levels: number, maxAgents: number) {
    return [{ name: 'spawn', label: 'Delegate task', description: `Delegate parts of your task. Results arrive automatically after this run; never poll or sleep waiting. models() lists the ids a task's model may name. Maximum depth ${levels} and ${maxAgents} active agents per profile.`,
      parameters: Type.Object({ tasks: TASKS }),
      execute: async (_id: string, args: { tasks: Task[] }, signal?: AbortSignal) => result(await this.start(args.tasks, cwd, signal, parentId)),
    }, { name: 'tell', label: 'Guide child', description: 'Send guidance to one of your direct children. A finished child is resumed with its earlier conversation, and its new report arrives automatically.',
      parameters: Type.Object({ id: Type.String(), message: Type.String() }),
      execute: async (_id: string, args: { id: string; message: string }) => {
        if (this.history.records.get(args.id)?.parentId !== parentId) throw new Error('You can only guide your own children.');
        return result(await this.tell(args.id, args.message, 'manager', parentId));
      },
    }];
  }
  /** Lets a child message its parent mid-run, the way tell lets the parent guide it. */
  private parentTool(id: string, parentId: string | undefined) {
    return { name: 'tell_parent', label: parentId ? 'Message parent agent' : 'Message main agent',
      description: `Send ${parentId ? 'your parent agent' : 'the main agent'} a question or important finding while you keep working. Its reply can arrive as guidance; continue useful work instead of polling. Your final answer is delivered automatically.`,
      parameters: Type.Object({ message: Type.String() }), execute: async (_id: string, args: { message: string }) => {
        const message = args.message.trim();
        if (!message) throw new Error('Message is empty.');
        const text = `[${id}] Message from subagent (still running): ${message}`;
        if (!await this.toParent(parentId, text)) throw new Error('Your parent is no longer running.');
        return result(parentId ? `Message sent to parent ${parentId}.` : 'Message sent to the main agent.');
      },
    };
  }
  /** A mid-run message to a child's parent: false if that parent is no longer running. */
  private async toParent(parentId: string | undefined, text: string) {
    if (!parentId) { await this.report(text); return true; }
    const parent = this.running.get(parentId);
    if (!parent || !['running', 'waiting', 'paused'].includes(parent.info.state)) return false;
    if (parent.info.state === 'running') await parent.session.steer(text);
    else { parent.pendingReports.push(text); parent.wake?.(); } // A paused parent keeps it until the user resumes it.
    this.changed();
    return true;
  }
  private async shutdown(session: AgentSession) {
    try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); }
    catch (error) { this.warn(`Subagent cleanup failed: ${String(error)}`); }
  }
  private dispose(session: AgentSession) {
    try { session.dispose(); } catch (error) { this.warn(`Subagent cleanup failed: ${String(error)}`); }
  }
  private directChildren(id: string) { return [...this.running.values()].filter(c => c.info.parentId === id); }
  private async execute(live: LiveRun, prompt: string) {
    const { session, info } = live;
    try {
      // A stop that lands before the first prompt has no turn to abort, so it is honoured here.
      const state: RunState = info.state; // a local, so the loop below still sees later state changes
      if (this.closing || state === 'stopping') throw new Error('Stopped before its first request.');
      await session.prompt(prompt);
      while (info.state !== 'stopping') {
        if (live.interruption) {
          // A message Pi took during the abort (a rebuild of its queue can still be landing) went into a request the abort
          // cancelled, so it got no reply: it goes in this prompt too. Only a stop's undelivered ones stay out.
          const guidance = live.interruption.filter(g => g.state !== 'undelivered');
          // Read Pi's queue only once a rebuild has landed, and take the interrupt's messages off it so they arrive once.
          // Until this is done, tell() holds new messages in pendingGuidance, where the turn below or a pause picks them up.
          await live.requeueing;
          const texts = new Set(guidance.map(g => g.text));
          await this.requeue(live, session.clearQueue().steering.filter(text => !texts.has(text)));
          live.interruption = undefined;
          if (!guidance.length) {
            // Nothing to hand over: the run waits for its next message instead of ending, and whoever waits on its report hears why.
            if (transition(info, 'paused')) {
              this.save(info);
              // In a grouped spawn the note takes the run's place, so its siblings' reports are not held until the user comes back; its later report arrives on its own.
              const note = `[${info.id}] Interrupted by the user; it waits for their next message, so no report until then.`, batch = live.batch;
              live.batch = undefined;
              await (batch ? this.deliver(info, batch, note) : this.toParent(info.parentId, note))
                .catch(error => this.warn(`Could not tell the parent about the interrupt: ${String(error)}`));
            }
            continue;
          }
          if (!transition(info, 'running')) continue; // A stop during the cleanup wins.
          for (const g of guidance) g.state = 'delivered';
          this.save(info);
          await session.prompt(interruptedWith(guidance.map(g => g.text)));
          continue;
        }
        const paused = info.state === 'paused';
        if (paused && !live.pendingGuidance.length) {
          await new Promise<void>(resolve => { live.wake = resolve; }); live.wake = undefined;
          continue;
        }
        const last = session.messages.findLast(m => m.role === 'assistant');
        // An error ends the turn, not the run: children still at work report to it and it answers them, as the main agent does.
        if (!paused && last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted') && !live.pendingReports.length && !this.directChildren(info.id).length) break;
        if (live.pendingGuidance.length) {
          transition(info, 'running'); this.save(info);
          await session.prompt(live.pendingGuidance.shift()!);
          continue;
        }
        if (live.pendingReports.length) {
          transition(info, 'running'); this.save(info);
          await session.prompt(live.pendingReports.splice(0).join('\n\n'));
          continue;
        }
        const children = this.directChildren(info.id).flatMap(child => child.completion ? [child.completion] : []);
        if (!children.length) break;
        const wake = new Promise<void>(resolve => { live.wake = resolve; });
        transition(info, 'waiting'); this.save(info);
        await Promise.race([...children, wake]); live.wake = undefined;
      }
      const last = session.messages.findLast(m => m.role === 'assistant');
      transition(info, info.state === 'stopping' || last?.role === 'assistant' && last.stopReason === 'aborted' ? 'stopped'
        : last?.role === 'assistant' && last.stopReason === 'error' ? 'failed' : 'completed');
      const text = session.getLastAssistantText();
      info.report = info.state === 'stopped' && live.stoppedBy ? stoppedReport(live.stoppedBy, text)
        : last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted') ? `Task ${last.stopReason}: ${last.errorMessage ?? 'No details'}` : text || 'Finished without a text report.';
    } catch (error) {
      transition(info, info.state === 'stopping' ? 'stopped' : 'failed');
      info.report = info.state === 'stopped' && live.stoppedBy ? stoppedReport(live.stoppedBy, session.getLastAssistantText()) : `${info.state}: ${String(error)}`;
    } finally {
      const children = this.directChildren(info.id);
      await Promise.allSettled(children.map(child => this.stop(child.info.id, 'parent')));
      await Promise.allSettled(children.flatMap(child => child.completion ? [child.completion] : []));
      info.ended = Date.now();
      for (const g of info.guidance) if (g.state === 'queued') g.state = 'undelivered';
      await this.shutdown(session);
      // A failed dispose must neither keep the slot taken nor drop the report below.
      this.dispose(session);
      // While this runs the run still counts as live, so a tell can't resume it into a worktree being removed. A run cut off
      // by Pi closing keeps its worktree as it is, to go on in it at the next start.
      if (info.worktree && !(info.cutOff && info.state === 'stopped')) info.report = `${info.report ?? ''}\n\n${await this.settleWorktree(info, info.worktree)}`;
      this.running.delete(info.id);
    }
    if (info.cutOff) {
      // Aborted by Pi closing, not by anyone's choice: no report now, the next start resumes it.
      if (info.state === 'stopped' && transition(info, 'interrupted')) { info.report = CUT_OFF; this.save(info); return; }
      delete info.cutOff; // It finished on its own while Pi was closing.
    }
    // Its cut-off children were named to it when it was resumed; having ended on its own, it no longer will resume them.
    if (!this.closing) for (const run of this.history.descendants(info.id)) if (run.cutOff) { delete run.cutOff; this.save(run); }
    // Said plainly, so the parent does not take the user's choice for a failure and delegate the task again.
    if (this.deleting.has(info.id)) info.report = 'Deleted by the user while it was working. The user dropped this task on purpose: do not redo it or delegate it again unless they ask.';
    // A metadata failure must not suppress delivery of the actual result.
    try { this.save(info); } catch (error) { this.warn(`Could not save run metadata: ${String(error)}`); }
    // A deleted run's transcript is gone.
    await this.deliver(info, live.batch, `[${info.id}] ${info.report}${this.deleting.has(info.id) ? '' : `\n\n${fullChat(info.id)}`}`);
  }
  /** Commits a settled run's changes on its branch and removes its worktree; never throws, since the report must still go out. */
  private async settleWorktree(info: RunInfo, tree: Worktree) {
    const title = info.task.trim().split('\n')[0].slice(0, 60);
    try { return await finishWorktree(tree, `OptChat subagent ${info.id}${info.role ? ` (${info.role})` : ''}: ${title}`); }
    catch (error) {
      this.warn(`Could not settle the worktree of ${info.id}: ${String(error)}`);
      return `Its worktree ${tree.path} (branch ${tree.branch}) could not be committed and removed, so it was left as it is: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  /** Sends a run's report to its parent; in a grouped spawn, only once every child of the spawn has one. */
  private async deliver(info: RunInfo, batch: LiveRun['batch'], text: string) {
    let count: number | undefined;
    if (batch) {
      batch.reports.set(info.id, text);
      const texts = batch.ids.flatMap(id => batch.reports.get(id) ?? []);
      if (texts.length < batch.ids.length) { if (!info.parentId) this.options.hold?.(batch.ids[0], texts); return; }
      text = texts.join('\n\n'); count = texts.length;
    }
    if (info.parentId) {
      const parent = this.running.get(info.parentId);
      if (parent && parent.info.state !== 'stopping') { parent.pendingReports.push(text); parent.wake?.(); this.changed(); }
      return;
    }
    if (this.closing) this.log('work', text);
    else try { await this.report(text, { count }); }
    catch (error) {
      this.log('work', text);
      this.warn(`Subagent report saved but could not wake the parent: ${String(error)}`);
    }
    if (batch && batch.ids.length > 1) this.options.hold?.(batch.ids[0], []);
  }
  /** `caller` is the agent sending a manager message: undefined for the main agent, else the parent subagent's ID. */
  async tell(id: string, message: string, source: 'manager' | 'user' = 'manager', caller?: string) {
    if (this.deleting.has(id)) throw new Error(`${id} is being deleted by the user.`);
    const live = this.running.get(id);
    if (!live && source === 'manager' && this.history.records.has(id)) return this.track(this.resume(id, message, caller));
    if (live && !['running', 'waiting', 'paused'].includes(live.info.state)) throw new Error(`${id} is finishing. Its report will arrive on its own${source === 'user' ? '' : '; tell it again after that to resume it'}.`);
    if (!live) throw new Error(`No running subagent ${id}.`);
    const text = message.trim(); if (!message.trim()) throw new Error('Message is empty.');
    if (source === 'user') this.log('user', `Direct guidance to subagent [${id}]: ${text}`);
    const guidance: RunInfo['guidance'][number] = { text, date: Date.now(), state: 'queued', from: source };
    live.info.guidance.push(guidance); this.save(live.info);
    try {
      await live.requeueing; // Keeps the queue in the order messages were sent.
      if (live.info.state === 'running' && !live.interruption) await live.session.steer(text);
      else { live.pendingGuidance.push(text); live.wake?.(); } // Waiting, paused or being interrupted: this message starts its next turn.
    }
    catch (error) { guidance.state = 'undelivered'; this.save(live.info); throw error; }
    if (guidance.state === 'undelivered') throw new Error(`${id} finished before it read the message. Tell it again to resume it.`);
    return 'Message queued for the next tool boundary.';
  }
  /**
   * The user's Ctrl+C, never destructive: aborts the current step. With guidance queued, the run continues at once with it;
   * with none, it pauses until the next message (from the user or a tell). Only stop() ends a run.
   */
  async interrupt(id: string): Promise<'continued' | 'paused'> {
    const live = this.running.get(id);
    if (live?.info.state === 'paused') return 'paused';
    if (!live || !['running', 'waiting'].includes(live.info.state)) throw new Error(`No running subagent ${id}.`);
    const guidance = live.info.guidance.filter(g => g.state === 'queued');
    // Nothing yields before the abort starts, so the run cannot finish in between and drop the messages.
    // They leave pendingGuidance and Pi's steering queue here, and execute() sends them in one prompt. Pi's queue must be empty
    // before the abort: after an aborted tool call Pi hands it to a request the abort cancels.
    const texts = new Set(guidance.map(g => g.text));
    live.pendingGuidance = live.pendingGuidance.filter(text => !texts.has(text));
    // The rest of the queue (a child's tell_parent message) follows the interrupt's prompt, as reports to a paused run do.
    live.pendingReports.push(...live.session.clearQueue().steering.filter(text => !texts.has(text)));
    live.interruption = guidance;
    live.wake?.();
    await live.session.abort();
    return guidance.length ? 'continued' : 'paused';
  }
  /** Takes the user's newest undelivered message back off the queue, to edit it; undefined when there is none left to take. */
  withdraw(id: string) {
    const live = this.running.get(id);
    const text = live?.info.guidance.findLast(g => g.state === 'queued' && g.from === 'user')?.text;
    if (!live || text === undefined || live.requeueing || live.interruption) return undefined;
    // The queue holds only texts, so of equal ones the last is taken back, record and queue entry alike.
    const guidance = live.info.guidance.findLast(g => g.state === 'queued' && g.text === text)!;
    const pending = live.pendingGuidance.lastIndexOf(guidance.text);
    if (pending >= 0) live.pendingGuidance.splice(pending, 1);
    else {
      const steering = live.session.getSteeringMessages();
      const at = steering.lastIndexOf(guidance.text);
      if (at < 0) return undefined; // Already on its way to the agent.
      // Pi cannot drop a single queued message: clear the queue and steer the rest back in order.
      void this.requeue(live, live.session.clearQueue().steering.filter((_, i) => i !== at));
    }
    live.info.guidance.splice(live.info.guidance.indexOf(guidance), 1); this.save(live.info);
    return guidance.text;
  }
  private requeue(live: LiveRun, texts: string[]) {
    const work: Promise<void> = (async () => {
      try { for (const text of texts) await live.session.steer(text); }
      catch (error) { this.warn(`Could not requeue a message for ${live.info.id}: ${String(error)}`); }
    })().finally(() => { if (live.requeueing === work) live.requeueing = undefined; });
    live.requeueing = work;
    return work;
  }
  /** Reopens a finished child from its saved transcript, same ID, parent and model, and gives it a new message. */
  private async resume(id: string, message: string, caller: string | undefined) {
    const run = this.history.records.get(id)!, text = message.trim();
    if (!text) throw new Error('Message is empty.');
    if (!['completed', 'failed', 'stopped', 'interrupted'].includes(run.state) || this.resuming.has(id)) throw new Error(`${id} is still finishing. Its report will arrive on its own.`);
    if (run.parentId !== caller) {
      if (!run.parentId) throw new Error(`Only the main agent can resume ${id}.`);
      const parent = this.running.get(run.parentId);
      throw new Error(parent && ['running', 'waiting', 'paused'].includes(parent.info.state) ? `Only ${id}'s parent ${run.parentId} can resume it. Ask ${run.parentId} with tell.`
        : `Only ${id}'s parent ${run.parentId} can resume it, and that parent is no longer running. Resume ${run.parentId} instead, or spawn a new subagent.`);
    }
    if (this.closing) throw new Error('Profile is closing.');
    if (this.full(1)) throw new Error(`Profile limit: at most ${this.settings.maxAgents} active agents, including parents and descendants. ${id} can be resumed when one finishes.`);
    let manager: SessionManager | undefined;
    try { if (run.sessionFile && existsSync(run.sessionFile)) manager = SessionManager.open(run.sessionFile); } catch { manager = undefined; }
    if (!manager?.getEntries().some(e => e.type === 'message')) throw new Error(`The saved transcript of ${id} is missing or unreadable, so it cannot be resumed. Spawn a fresh subagent and give it the context it needs.`);
    const model = this.find(run.model);
    if (!model) throw new Error(`${id}'s model ${run.model} is not available, so it cannot be resumed. Spawn a fresh subagent instead.`);
    // A worktree is removed when its run settles; resuming the run brings it back on the same branch.
    if (run.worktree) {
      this.resuming.add(id); // A second tell meanwhile is told it is still finishing.
      try { await reopenWorktree(run.worktree); }
      catch (error) { throw new Error(`${id}'s worktree could not be restored (${error instanceof Error ? error.message : String(error)}), so it cannot be resumed. Spawn a fresh subagent instead.`); }
      finally { this.resuming.delete(id); }
      if (this.closing) throw new Error('Profile is closing.');
    }
    if (!existsSync(run.cwd) || !statSync(run.cwd).isDirectory()) throw new Error(`${id}'s directory ${run.cwd} no longer exists, so it cannot be resumed. Spawn a fresh subagent instead.`);
    this.launching++; this.resuming.add(id);
    let reserved = true;
    try {
      // No thinking level: the session restores the one it ran with.
      // Runs saved before these options existed had all tools and memory on.
      const session = await this.open({ id, directory: run.cwd, depth: run.depth, parentId: run.parentId, model, sessionManager: manager,
        tools: run.tools ?? 'all', memory: run.memory ?? true, worktree: run.worktree });
      // stop() cannot see this child until it is registered, so a parent stopped meanwhile must cancel it here.
      const parent = run.parentId ? this.running.get(run.parentId) : undefined;
      if (this.closing || run.parentId && (!parent || !['running', 'waiting', 'paused'].includes(parent.info.state))) {
        await this.shutdown(session); this.dispose(session); throw new Error('Parent or profile is stopping.');
      }
      // The finished record stays untouched (and resumable) unless the new one is saved.
      const { ended: _ended, cutOff: _cutOff, ...rest } = run;
      const cut = [...this.history.records.values()].filter(r => r.parentId === id && r.cutOff).map(r => r.id);
      const prompt = cutOffChildren(text, cut);
      const info: RunInfo = { ...rest, state: 'running', started: Date.now(), parentSession: this.options.parentSession ?? run.parentSession,
        guidance: [...run.guidance, { text: prompt, date: Date.now(), state: 'queued', from: 'manager' }] };
      try { this.save(info); } catch (error) { this.history.records.set(id, run); await this.shutdown(session); this.dispose(session); throw error; }
      const live: LiveRun = { session, info, updated: Date.now(), tools: new Map(), pendingReports: [], pendingGuidance: [] };
      this.running.set(id, live);
      this.launching--; reserved = false;
      session.subscribe(event => this.observe(live, event));
      const work = this.execute(live, prompt).catch(error => this.warn(`Subagent completion failed: ${String(error)}`))
        .finally(() => { this.completions.delete(work); this.changed(); });
      this.completions.add(work);
      live.completion = work;
    } finally { if (reserved) this.launching--; this.resuming.delete(id); }
    this.changed();
    return `${id} had finished, so I resumed it with its earlier conversation. Its new report will come back on its own.`;
  }
  /**
   * Resumes the main agent's subagents that the last Pi close or crash cut off, then tells the main agent once.
   * Cut-off children of a cut-off parent wait for it: resuming it names them, and its `tell` resumes them.
   */
  async resumeCutOff() {
    const cut = [...this.history.records.values()].filter(run => run.cutOff).sort((a, b) => a.depth - b.depth || a.started - b.started).map(run => run.id);
    const resumed: string[] = [], lines: string[] = [], orphans: string[] = [];
    // Always the current record: a `tell` during startup may have resumed the run and replaced it meanwhile.
    const current = (id: string) => { const run = this.history.records.get(id); return run?.cutOff ? run : undefined; };
    const drop = (run: RunInfo) => { delete run.cutOff; this.save(run); };
    for (const id of cut) {
      const run = current(id);
      if (!run) continue;
      if (run.parentId) {
        // Its parent was not cut off (it was paused, say) or could not be resumed: nobody else will mention it.
        if (!this.history.records.get(run.parentId)?.cutOff && !this.running.has(run.parentId)) { orphans.push(`${run.id} (under ${run.parentId})`); drop(run); }
        continue;
      }
      try { await this.track(this.resume(id, RESTARTED, undefined)); resumed.push(id); }
      catch (error) {
        const still = current(id);
        if (!still) continue; // Resumed by someone else meanwhile.
        lines.push(`Could not resume ${id}: ${error instanceof Error ? error.message : String(error)}`); drop(still);
      }
    }
    if (orphans.length) lines.push(`Also cut off, but not resumed because their parent agent is not running: ${orphans.join(', ')}.`);
    if (!resumed.length && !lines.length) return;
    await this.report([`Pi restarted while subagents were working.${resumed.length ? ` Resumed ${resumed.join(', ')} from where ${resumed.length > 1 ? 'they' : 'it'} left off; ${this.settings.groupReports
      ? 'grouped reports do not survive a restart, so each one reports on its own.' : 'reports arrive as usual.'}` : ''}`, ...lines].join('\n'));
  }
  /** Ends a run and its descendants; `cause` is said in its report (the user's Ctrl+X by default). */
  async stop(id: string, cause: StopCause = 'user') {
    const live = this.running.get(id);
    if (!live) throw new Error(`No running subagent ${id}.`);
    const descendants: LiveRun[] = [];
    const collect = (run: LiveRun) => { descendants.push(run); for (const child of this.directChildren(run.info.id)) collect(child); };
    collect(live);
    const stopping = descendants.filter(run => transition(run.info, 'stopping'));
    for (const run of stopping) {
      run.stoppedBy ??= run === live ? cause : 'parent';
      run.wake?.();
      try { this.save(run.info); } catch (error) { this.warn(`Could not save stop status: ${String(error)}`); }
    }
    await Promise.allSettled(stopping.map(run => run.session.abort()));
  }
  /** The user's delete: stops the run and its descendants if they still work, lets their reports reach their parents, then deletes their files. */
  async remove(id: string) {
    if (!this.history.records.has(id)) throw new Error(`No subagent ${id}.`);
    if (this.deleting.has(id)) throw new Error(`${id} is already being deleted.`);
    // A run that is live while being deleted reports its own deletion, even one a tell was resuming; a finished one has nothing left to say, so memory is told here.
    let reports = false;
    const runs = () => [id, ...this.history.descendants(id).map(run => run.id)], marked = new Set<string>();
    // An overlapping delete of a descendant keeps its own marks, so neither delete clears the other's.
    const mark = () => { for (const run of runs()) if (!this.deleting.has(run)) { marked.add(run); this.deleting.add(run); } };
    mark(); this.changed();
    try {
      // Launches and resumes register their runs before they settle, and a stopped parent can still have children launching.
      for (;;) {
        await Promise.allSettled(this.launches);
        const live = runs().flatMap(run => this.running.get(run) ?? []);
        if (!live.length) break;
        if (live.some(run => run.info.id === id)) reports = true;
        mark();
        await Promise.allSettled(live.map(run => this.stop(run.info.id)));
        await Promise.allSettled(live.map(run => run.completion));
      }
      mark();
      const records = runs().flatMap(run => this.history.records.get(run) ?? []);
      for (const run of records.reverse()) this.history.remove(run.id); // Children first, so a failure never leaves one without its parent.
      if (!reports) this.log('work', `[${id}] deleted by the user`);
    } finally { for (const run of marked) this.deleting.delete(run); this.changed(); }
  }
  async close() {
    this.closing = true;
    // Only work in progress is picked up at the next start: not paused runs waiting for the user, or runs being stopped.
    for (const { info } of this.running.values()) if (info.state === 'running' || info.state === 'waiting') info.cutOff = true;
    await Promise.allSettled([...this.running.keys()].map(id => this.stop(id, 'pi')));
    await Promise.allSettled(this.launches);
    await Promise.allSettled(this.completions);
  }
}
