import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { parseArgs, parseSkillBlock, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Memory, type Compressor } from './memory.ts';
import { atomicWrite } from './store.ts';
import { createCompressor, type ModelChoice } from './compactor.ts';
import { createProfile, instructions, isWindows, lastProfile, listProfiles, loadConfig, profilePath, rememberProfile, saveConfig, type ProfileConfig } from './profiles.ts';
import { allowSearch, CONTINUITY, IMPORT_GUIDANCE, MASTER, modelsHint, PEERS_DOC, SEARCH_DOC, TURN_REFRESHED, VIEW_DOC } from './prompts.ts';
import { cachePayload, record } from './cache.ts';
import { saveImages } from './images.ts';
import { asUser, boundedMessage, atWork, buildContext, logMessage, previousExchange, refreshedRun, refreshBudget, refreshFraction, refreshPoint, reportReceipt, REPORT_RECEIPT, REPORT_TYPE, RUN_BOUNDARY, textContent, typedText } from './transcript.ts';
import { registerReportRenderer, type ReportDetails } from './report-message.ts';
import { memoryTools, result, searchTool } from './tools.ts';
import { askPeer, livePeers, notePeer, notesText, peekNotes, peersText, publishTurn, publishView, turnLines } from './peers.ts';
import { Children, loadedBuiltins, modelsTool, refreshContextFiles, TASKS } from './agents.ts';
import { isActiveRun, type RunInfo } from './runs.ts';
import { exportBrowser } from './browser.ts';
import { Inbox } from './inbox.ts';
import { checkpoint } from './checkpoint.ts';
import { closeInfo, listBranches, liveStatus, mergeBranch, openBranchMemory, otherTranscript, recoverBranches, resetBranch, saveInfo, startBranch, trunkState, type BranchInfo, type MergeReason } from './branch.ts';
import { LockBusy, lockPath, takeLock } from './locks.ts';
import { memoryDirectory, pendingImport, prepareImport, runImport, discardImport } from './import/job.ts';
import { chooseImport, showProgress } from './import/ui.ts';
import { UsageLedger } from './usage.ts';
import { oneLine, showInspector, type InspectorPage } from './inspector.ts';
import { showAgentView } from './agent-view.ts';
import { inspectorShortcut, mountNavigation } from './navigation.ts';
import { mainTitle, TabTitle } from './title.ts';
import { showModelPicker, showSettings } from './settings-page.ts';
import { showMenu } from './menu.ts';

const binding = 'optchat.profile';
const toggle = (prompt: string, line: string, on: boolean, after: string) => on === prompt.includes(line) ? prompt : on ? prompt.replace(after, after + line) : prompt.replace(line, '');
/** A report run while idle reuses the last built prompt, so Previous exchange and Memory search changes since then are applied here. */
const promptFor = (prompt: string, { previousExchange, memorySearch }: ProfileConfig) =>
  allowSearch(toggle(toggle(prompt, CONTINUITY, previousExchange, VIEW_DOC), SEARCH_DOC, memorySearch, previousExchange ? VIEW_DOC + CONTINUITY : VIEW_DOC), memorySearch);
/** This session's branch of the profile (src/branch.ts): its folder, its info, and the release of its live lock. `merged`: how much
 * of the branch's log the trunk has. `seen`: the view's batch merges already looked at for a rebase. `changed`: when the log last grew. */
interface Branch { dir: string; info: BranchInfo; release: () => Promise<void>; setStatus: (status: Record<string, unknown>) => void;
  merged: number; seen: number; length: number; changed: number }
interface Active { name: string; dir: string; config: ProfileConfig; memory: Memory; inbox: Inbox; children: Children; usage: UsageLedger;
  branch: Branch; compress: Compressor }
/** How often an open session checks whether it has been idle long enough to merge. OPTCHAT_IDLE_MS (milliseconds) overrides
 * the Merge when idle setting, for tests. */
const idleMs = (config: ProfileConfig) => process.env.OPTCHAT_IDLE_MS ? Number(process.env.OPTCHAT_IDLE_MS) : config.idleMergeMinutes * 60_000;

/** OptChat's own version, read from the package.json beside src/ (in the checkout and the npm package alike); none if unreadable. */
export const version = ((): string | undefined => {
  try {
    const data: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return data && typeof data === 'object' && 'version' in data && typeof data.version === 'string' ? data.version : undefined;
  } catch { return undefined; }
})();
const brand = version ? `OptChat v${version}` : 'OptChat';

export default function optchat(pi: ExtensionAPI) {
  let active: Active | undefined;
  let recovery: Promise<void> | undefined;
  let run: AgentMessage[] = [];
  let previous: AgentMessage[] = [];
  let logged = 0;
  /** After a mid-turn refresh (#146), the run is sent from here on, after its task; 0 sends it whole. */
  let keep = 0;
  let view: string | undefined;
  let prompt = '';
  let runStarted = false;
  /** The peers this run left a note: one each per turn, so a note can't turn into a chat. */
  let noted = new Set<string>();
  let fault: string | undefined;
  /** Reports not yet in memory. `count`: how many subagent reports the text joins. `batch`: held while the rest of that spawn runs, not sent yet.
   * `steered`: last sent into a running turn, where Esc or a dequeue can clear it from Pi's queue unseen. */
  let reports: { text: string; count?: number; batch?: string; steered?: boolean }[] = [];
  type Report = (typeof reports)[number];
  let idle = () => true;
  const receipts = new Map<AgentMessage, string>();
  let checkpoints = Promise.resolve();
  let importing = false;
  let stopping = false;
  let importController: AbortController | undefined;
  let importTask: Promise<void> | undefined;
  let unmountNavigation: (() => void) | undefined;
  let inspectorController: AbortController | undefined;
  const shortcut = inspectorShortcut();
  const title = new TabTitle();
  let working = false;
  let untitle: (() => void) | undefined;
  const showTitle = (ctx: ExtensionContext) => {
    const a = active;
    if (a) title.show(text => ctx.ui.setTitle(text), mainTitle(a.name, working, a.children.ids.length));
  };
  /** Journals written before batches held plain strings. */
  const isPendingReport = (s: unknown): s is string | { text: string; count?: number } =>
    typeof s === 'string' || record(s) && typeof s.text === 'string' && (s.count === undefined || typeof s.count === 'number');
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
  pi.registerFlag('optchat-profile', { description: 'OptChat profile (required for noninteractive sessions without a saved binding)', type: 'string' });
  // The main model follows the profile: each pick in Pi is saved to its config.json, and opening the profile picks it again.
  // `--model`/`--provider`/`--thinking` on Pi's command line win over the saved choice for as long as this Pi runs; `--models` only keeps a saved model inside its scope.
  const launch = parseArgs(process.argv.slice(2)), pinnedModel = launch.model !== undefined || launch.provider !== undefined;
  // `restored`: where the last restore left Pi. Pi fires thinking_level_select without awaiting it, so a handler may run after the restore; that state isn't a pick.
  let restoring = false, restored: ModelChoice | undefined;
  const sameChoice = (a: ModelChoice | undefined, b: ModelChoice) => a?.provider === b.provider && a.model === b.model && a.thinking === b.thinking;
  const mainChoice = ({ model }: ExtensionContext): ModelChoice | undefined => model && { provider: model.provider, model: model.id, thinking: pi.getThinkingLevel() };
  const rememberMain = (ctx: ExtensionContext) => {
    // Read Pi's state, not the event: a model switch reports its thinking level before the model, and a late handler sees where both ended up.
    const a = active, main = mainChoice(ctx);
    if (restoring || !a || !main || sameChoice(restored, main)) return;
    restored = undefined;
    if (sameChoice(a.config.main, main)) return;
    try { saveConfig(a.dir, { ...a.config, main }); a.config.main = main; }
    catch (error) { ctx.ui.notify(`Could not save the main model to ${a.name}: ${errorText(error)}`, 'error'); }
  };
  pi.on('model_select', (_event, ctx) => rememberMain(ctx));
  pi.on('thinking_level_select', (_event, ctx) => rememberMain(ctx));
  const restoreMain = async (ctx: ExtensionContext, { name, config: { main } }: Active) => {
    restored = undefined;
    if (!main || pinnedModel || launch.models && !ctx.scopedModels.some(({ model }) => model.provider === main.provider && model.id === main.model)) return;
    const model = ctx.modelRegistry.find(main.provider, main.model), thinking = launch.thinking ?? main.thinking;
    restoring = true;
    try {
      const current = ctx.model?.provider === main.provider && ctx.model.id === main.model;
      if (!model || !current && !await pi.setModel(model).catch(() => false)) {
        ctx.ui.notify(`${name}'s main model ${main.provider}/${main.model} is unavailable; keeping ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'Pi\'s default'}.`, 'warning');
        return;
      }
      pi.setThinkingLevel(thinking);
      restored = mainChoice(ctx);
    } finally { restoring = false; }
  };
  const required = () => { if (!active) throw new Error('Choose an OptChat profile first: /optchat profile'); return active; };
  const status = (ctx: ExtensionContext) => {
    const a = active;
    if (!a) { ctx.ui.setStatus('optchat', 'OptChat: choose profile'); return; }
    // A display only: a broken import journal is refused where it matters, never here.
    let note = '';
    try { note = importing ? ' · importing' : pendingImport(a.dir) ? ' · import paused: /optchat import' : ''; }
    catch { note = ' · import journal invalid'; }
    ctx.ui.setStatus('optchat', `OptChat: ${a.name} · branch ${a.branch.info.id} · ${a.memory.root.length} messages · ${a.memory.pending} pending · ${a.children.ids.length} agents${note}`);
  };
  // `steered` describes this process's Pi queue, so it is not journaled.
  const saveReports = () => { if (active) atomicWrite(join(active.branch.dir, 'pending-reports.json'), JSON.stringify(reports, (key, value: unknown) => key === 'steered' ? undefined : value)); };
  const flush = () => {
    if (!active) return;
    while (logged < run.length) {
      const message = run[logged];
      const receipt = receipts.get(message);
      logMessage(active.memory, message, receipt); logged++;
      if (receipt && !receipt.startsWith(REPORT_RECEIPT)) active.inbox.acknowledge(receipt);
      receipts.delete(message);
      if (message.role === 'user') {
        const text = textContent(message.content), index = reports.findIndex(r => !r.batch && r.text === text);
        if (index >= 0) { reports.splice(index, 1); saveReports(); }
      }
    }
  };
  // Shown as a dark background box, not as the user's own message. Before this profile has run once there is no
  // built system prompt to reuse, so that rare case still goes through Pi's normal prompt path as a user message.
  const sendReport = (report: Report) => {
    const { text, count } = report;
    report.steered = !idle();
    if (prompt) pi.sendMessage<ReportDetails>({ customType: REPORT_TYPE, content: text, display: true, details: { count } }, { triggerTurn: true, deliverAs: 'steer' });
    else pi.sendUserMessage(text, { deliverAs: 'steer', expandPromptTemplates: false });
  };
  const deliverReport = async (text: string, { once = false, count }: { once?: boolean; count?: number } = {}) => {
    if (once && (active?.memory.root.some(e => e.receipt === reportReceipt(text)) || reports.some(r => r.text === text))) return;
    const report = { text, count };
    reports.push(report); saveReports();
    if (!stopping) sendReport(report);
  };
  const holdReports = (batch: string, texts: string[]) => {
    reports = [...reports.filter(r => r.batch !== batch), ...texts.length ? [{ text: texts.join('\n\n'), count: texts.length, batch }] : []];
    saveReports();
  };
  /** Merges what the trunk doesn't have yet of this branch. One merge at a time; a failure only warns, and the next merge (or,
   * after a crash, the next Pi to open the profile) picks up the same messages. */
  let merging: Promise<unknown> = Promise.resolve();
  const merge = (a: Active, reason: MergeReason, warn: (text: string) => void) => {
    const next = merging.catch(() => {}).then(async () => {
      const { branch, memory } = a, length = memory.root.length;
      const result = await mergeBranch(a.dir, branch.dir, branch.info, memory.root, memory.tree.values(), reason, warn);
      branch.merged = Math.max(branch.merged, length);
      return result;
    });
    merging = next;
    return next;
  };
  /** Merges everything this branch said and marks it closed. */
  const closeBranch = async (a: Active) => {
    if (a.branch.info.closed) return;
    a.branch.info.closing = true; saveInfo(a.branch.dir, a.branch.info);
    await merge(a, 'close', () => {});
    closeInfo(a.branch.dir, a.branch.info);
  };
  const stop = async () => {
    inspectorController?.abort(); unmountNavigation?.(); unmountNavigation = undefined;
    stopping = true; importController?.abort(); await importTask?.catch(() => {});
    clearInterval(idleTimer); idleTimer = undefined;
    if (!active) return;
    const old = active;
    // Peers stop listing it and sending it notes from here on; the ones already sent go into its memory below.
    try { old.branch.setStatus({ cwd: old.branch.info.cwd, pid: process.pid, created: old.branch.info.created, closing: true }); } catch { /* a status is a courtesy */ }
    try {
      await recovery;
      await old.children.close(); flush();
      if (!pendingImport(old.dir)) {
        old.inbox.recover(old.memory);
        // Reports this session never got to deliver go into its memory as they are, so the trunk has them: the next session
        // is another branch, with its own journal, and would never deliver them.
        const logged = new Set(old.memory.root.map(e => e.receipt));
        for (const r of reports) if (!logged.has(reportReceipt(r.text))) old.memory.append('work', r.text, undefined, reportReceipt(r.text));
        reports = []; saveReports();
        // So do notes from other sessions that no input of this one carried.
        const { notes, commit } = peekNotes(old.branch.dir);
        for (const note of notes) old.memory.append('user', notesText([note]), note.date);
        commit();
      }
      // No checkpoint here: a host may kill Pi a second after asking it to stop (#220). The next turn's checkpoint commits what this wrote.
      await old.memory.close(); await checkpoints;
      // The merge is a few file appends under the trunk lock. If Pi is killed before it ends, `closing` makes the next Pi on
      // this profile finish it as a close rather than as a crash.
      if (!pendingImport(old.dir)) await closeBranch(old);
    } finally {
      await old.memory.close(); await old.branch.release(); active = undefined;
      run = []; previous = []; logged = 0; keep = 0; view = undefined; runStarted = false; receipts.clear(); prompt = ''; idle = () => true;
      untitle?.(); untitle = undefined; title.clear(); working = false;
    }
  };
  const chooseProfile = async (ctx: ExtensionContext): Promise<string | undefined> => {
    // Outside the TUI (print, json, RPC hosts) never pick or create a profile: a dialog would hang the host, and a guess could write into the wrong memory.
    if (ctx.mode !== 'tui') return undefined;
    const names = listProfiles(), last = lastProfile();
    if (last) names.sort((a, b) => Number(b === last) - Number(a === last));
    const selected = await ctx.ui.select('OptChat profile', [...names, '+ Create profile']);
    if (selected !== '+ Create profile') return selected;
    const name = (await ctx.ui.input('New profile name', 'work or personal'))?.trim();
    if (!name) return undefined;
    createProfile(name); return name;
  };
  const mountNav = (ctx: ExtensionContext) => {
    unmountNavigation?.(); unmountNavigation = undefined;
    const a = active;
    if (a && ctx.mode === 'tui') unmountNavigation = mountNavigation(ctx, a.children, a.memory, shortcut, page => { void inspect(ctx, page); });
  };
  /** Every minute (or OPTCHAT_IDLE_MS / 2): once the log has stood still for the Merge when idle time, merge what's new. */
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  const watchIdle = (ctx: ExtensionContext) => {
    clearInterval(idleTimer);
    const a = active;
    if (!a) return;
    idleTimer = setInterval(() => {
      const wait = idleMs(a.config), { branch, memory } = a;
      if (active !== a || !wait || stopping || importing) return;
      if (memory.root.length !== branch.length) { branch.length = memory.root.length; branch.changed = Date.now(); return; }
      if (runStarted || !idle() || memory.root.length <= branch.merged || Date.now() - branch.changed < wait) return;
      void merge(a, 'idle', warning => ctx.ui.notify(warning, 'warning'))
        .then(result => { if (result.added) ctx.ui.notify(`OptChat merged ${result.added} messages into ${a.name}'s shared memory (idle).`, 'info'); status(ctx); })
        .catch(error => ctx.ui.notify(`OptChat could not merge while idle: ${errorText(error)}`, 'warning'));
    }, Math.min(60_000, Math.max(50, (idleMs(a.config) || 60_000) / 2)));
    idleTimer.unref();
  };
  /** Once this branch's view has started a batch merge (its cached prefix is gone anyway) and another session has merged since
   * this one started, merge this one and start again from the trunk's end, so it sees what the others did. */
  const rebase = async (a: Active, ctx: ExtensionContext) => {
    const { branch } = a;
    if (a.memory.batches <= branch.seen) return;
    branch.seen = a.memory.batches;
    const warn = (warning: string) => ctx.ui.notify(warning, 'warning');
    const before = await trunkState(a.dir, warn);
    if (!before.foreign(branch.info.id, branch.info.base)) return;
    ctx.ui.setWorkingMessage('OptChat: catching up with the other sessions on this profile…');
    try {
      const old = a.memory;
      // A subagent can log a line while the merge waits for the lock; merge until nothing is left behind.
      for (let tries = 0; tries < 3 && branch.merged < old.root.length; tries++) await merge(a, 'rebase', warn);
      if (branch.merged < old.root.length) throw new Error('the log kept growing');
      await old.close();
      const trunk = await trunkState(a.dir, warn);
      resetBranch(branch.dir, branch.info, trunk.length, trunk.view);
      const memory = await openBranchMemory(a.dir, branch.dir, branch.info, a.compress, warning => ctx.ui.notify(warning, 'error'), undefined, a.config.jobs);
      a.memory = memory; a.children.memory = memory;
      Object.assign(branch, { merged: memory.root.length, seen: memory.batches, length: memory.root.length, changed: Date.now() });
      mountNav(ctx);
      ctx.ui.notify(`OptChat caught up with the other sessions on ${a.name}: this session now starts from message ${branch.info.base}.`, 'info');
    } catch (error) {
      // A memory left closed can't log the turn: stop it here rather than lose what it says.
      if (a.memory.closed) fault = `OptChat could not catch up with the other sessions: ${errorText(error)}. Restart Pi.`;
      ctx.ui.notify(`OptChat could not catch up with the other sessions: ${errorText(error)}`, 'warning');
    } finally { ctx.ui.setWorkingMessage(); }
  };
  const openProfile = async (name: string, ctx: ExtensionContext) => {
    const dir = profilePath(name);
    if (!existsSync(dir)) throw new Error(`Profile ${name} does not exist. Use /optchat profile to create it.`);
    const config = loadConfig(dir);
    const quiet = (warning: string) => ctx.ui.notify(warning, 'warning');
    // Sessions whose Pi crashed or was killed are merged first, so this one starts with what they said.
    const recovered = await recoverBranches(dir, quiet);
    if (recovered.length) ctx.ui.notify(`OptChat merged ${recovered.length} session${recovered.length === 1 ? '' : 's'} that ended without closing (${recovered.join(', ')}) into ${name}'s shared memory.`, 'info');
    const started = await startBranch(dir, ctx.cwd, quiet);
    let openingMemory: Memory | undefined;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const usage = new UsageLedger(dir);
      usage.backfill(ctx.sessionManager.getEntries(), sessionId);
      const pending = join(started.dir, 'pending-reports.json');
      const saved: unknown = existsSync(pending) ? JSON.parse(readFileSync(pending, 'utf8')) : [];
      if (!Array.isArray(saved) || !saved.every(isPendingReport)) throw new Error('Invalid pending report journal.');
      const compress = createCompressor(ctx.modelRegistry, () => config.compactor, message => {
        usage.compression(message, 'compactor', sessionId);
        status(ctx);
      }, () => config.summaryAcceptBytes);
      const memory = await openBranchMemory(dir, started.dir, started.info, compress, warning => ctx.ui.notify(warning, 'error'), undefined, config.jobs);
      openingMemory = memory;
      const inbox = new Inbox(started.dir);
      const recoveredInputs = pendingImport(dir) ? 0 : inbox.recover(memory);
      if (recoveredInputs) ctx.ui.notify(`Recovered ${recoveredInputs} unanswered inputs into ${name}'s memory. Ask to continue them when ready.`, 'info');
      const children = new Children(memory, ctx.modelRegistry, () => config.subagent, () => `${instructions(dir)}\n\n${IMPORT_GUIDANCE}`,
        deliverReport, text => ctx.ui.notify(text, 'error'), started.dir, { parentSession: sessionId, usage, builtins: () => loadedBuiltins(pi), settings: () => config, hold: holdReports });
      const loggedReports = new Set(memory.root.map(e => e.receipt));
      // Reports a crash held back with their unfinished siblings are delivered now, as they are.
      reports = saved.map(s => typeof s === 'string' ? { text: s } : { text: s.text, count: s.count })
        .filter(r => !loggedReports.has(reportReceipt(r.text)));
      atomicWrite(pending, JSON.stringify(reports));
      rememberProfile(name);
      const branch: Branch = { ...started, merged: memory.root.length, seen: memory.batches, length: memory.root.length, changed: Date.now() };
      active = { name, dir, config, memory, inbox, children, usage, branch, compress }; fault = undefined; idle = () => ctx.isIdle();
      share(ctx);
      try { publishView(started.dir, memory.render()); } catch { /* published again after each turn */ }
      await restoreMain(ctx, active);
      mountNav(ctx);
      watchIdle(ctx);
      untitle = children.subscribe(() => showTitle(ctx)); showTitle(ctx);
      status(ctx);
      const others = (await Promise.all(listBranches(dir).filter(b => !b.closed && b.id !== started.info.id).map(b => liveStatus(dir, b.id)))).filter(Boolean).length;
      ctx.ui.notify(`${brand} · ${name} · branch ${started.info.id} · ${memory.root.length} messages${others ? ` · ${others} other session${others === 1 ? '' : 's'} open` : ''}\nCompactor: ${config.compactor.provider}/${config.compactor.model} (${config.compactor.thinking})`, 'info');
      const queuedReports = [...reports];
      // Only an interactive Pi picks cut-off subagents up: a one-shot headless run would stop them again as it exits.
      if (!pendingImport(dir) && ctx.mode === 'tui') recovery = children.resumeCutOff().catch(error => ctx.ui.notify(`Resuming subagents: ${errorText(error)}`, 'error'));
      setImmediate(() => { if (active?.memory === memory && !pendingImport(dir)) for (const r of queuedReports) sendReport(r); });
    } catch (error) {
      untitle?.(); untitle = undefined; title.clear();
      clearInterval(idleTimer); idleTimer = undefined;
      if (active && active.memory === openingMemory) {
        unmountNavigation?.(); unmountNavigation = undefined;
        await active.children.close(); active = undefined;
      }
      await openingMemory?.close();
      // A branch that never opened is closed as it is, if it holds nothing: no messages of its own, no journal it took over.
      // Otherwise it stays open, so the next start recovers it (or keeps failing on it, rather than drop what is in it).
      const journaled = ['pending-inputs.json', 'pending-reports.json'].some(file => {
        try { return readFileSync(join(started.dir, file), 'utf8').trim() !== '[]'; } catch (e) { return existsSync(join(started.dir, file)); }
      });
      const own = existsSync(join(started.dir, 'main')) && readdirSync(join(started.dir, 'main')).some(file => statSync(join(started.dir, 'main', file)).size > 0);
      if (!journaled && !own) try { closeInfo(started.dir, started.info); } catch { /* the next start recovers it */ }
      await started.release(); throw error;
    }
  };

  pi.on('session_start', async (_event, ctx) => {
    stopping = false;
    const entries = ctx.sessionManager.getEntries();
    const saved = entries.findLast(e => e.type === 'custom' && e.customType === binding);
    const boundName = saved?.type === 'custom' && record(saved.data) && typeof saved.data.name === 'string' ? saved.data.name : undefined;
    const flag = pi.getFlag('optchat-profile');
    try {
      if (boundName && typeof flag === 'string' && flag !== boundName) throw new Error(`Session belongs to ${boundName}; cannot resume it as ${flag}.`);
      const name = boundName ?? (typeof flag === 'string' ? flag : await chooseProfile(ctx));
      if (!name) { status(ctx); return; }
      // A profile another Pi holds fails here (the older OptChat's lock) like any other profile that cannot open.
      await openProfile(name, ctx);
      if (name !== boundName) pi.appendEntry(binding, { name });
    } catch (error) {
      if (active) await stop().catch(() => {});
      fault = errorText(error);
      // Pi reports a throwing handler on stderr (print) or as an extension_error event (RPC); notify there is a no-op or easy to miss.
      if (ctx.mode !== 'tui') throw error;
      ctx.ui.notify(fault, 'error');
    }
    // Pi sets its own title once every session_start handler has finished, so put ours back afterwards.
    for (const ms of [0, 250, 1000]) setTimeout(() => title.reapply(), ms).unref();
  });
  pi.on('session_info_changed', () => title.reapply()); // Pi retitles the tab on session renames, just before this.
  pi.on('session_shutdown', stop);
  // Pi shows nothing when a switch is cancelled, so say why and what lets it through.
  const blockSwitch = (command: string, ctx: ExtensionContext) => {
    const children = active?.children, runs = children?.active ? children.ids.flatMap(id => children.live(id)?.info ?? []) : [];
    const label = (run: RunInfo) => !isActiveRun(run) ? 'finishing'
      : run.state === 'paused' ? 'interrupted, waiting for you' : run.state === 'stopping' ? 'stopping' : 'working';
    const it = runs.length === 1 ? 'it' : 'them';
    const how = runs.some(run => run.state === 'paused') ? `Open ${it} in /optchat agents and message ${it} to resume, or press Ctrl+X twice to stop.`
      : `Wait for ${it} to finish, or open ${it} in /optchat agents and press Ctrl+X twice.`;
    const why = importing ? 'while an import is open. Close the import dialog or pause the import (Escape), then try again.'
      : !children?.active ? undefined
      : !runs.length ? 'while agents are starting or finishing. Try again in a moment.'
      : `while ${runs.length === 1 ? '1 agent is' : `${runs.length} agents are`} active: ${runs.map(run => `${run.id} (${label(run)})`).join(', ')}. ${how}`;
    if (!why) return undefined;
    ctx.ui.notify(`${command} is blocked ${why}`, 'warning');
    return { cancel: true };
  };
  pi.on('session_before_switch', (event, ctx) => blockSwitch(event.reason === 'new' ? '/new' : '/resume', ctx));
  pi.on('session_before_fork', (event, ctx) => blockSwitch(event.position === 'at' ? '/clone' : '/fork', ctx));
  pi.on('input', async (event, ctx) => {
    if (!active) {
      // Without a profile or flag, a headless run is plain Pi. A requested profile that failed to open refuses instead of running without memory.
      if (ctx.mode !== 'tui' && !fault) return { action: 'continue' };
      ctx.ui.notify(fault ?? 'Select a profile with /optchat profile before chatting.', 'error'); return { action: 'handled' };
    }
    if (importing || pendingImport(active.dir)) { ctx.ui.notify('This profile has an import in progress. Use /optchat import to resume or discard it, or switch profiles.', 'info'); return { action: 'handled' }; }
    if (event.source !== 'extension') {
      // Notes other sessions left go at the end of the next thing the user sends, so they never start a turn of their own. Not
      // on a queued input, which Esc can take back, nor on a command: Pi expands skills and templates after this, and a note
      // would become part of their arguments.
      let text = event.text;
      try {
        const { notes, commit } = event.streamingBehavior === undefined && !text.trimStart().startsWith('/') ? peekNotes(active.branch.dir) : { notes: [], commit: () => {} };
        if (notes.length) text = `${text}\n\n${notesText(notes)}`;
        active.inbox.record(text, event.streamingBehavior !== undefined);
        commit();
      } catch (error) { ctx.ui.notify(`Could not save input: ${errorText(error)}`, 'error'); return { action: 'handled' }; }
      if (text !== event.text) return { action: 'transform', text, images: event.images };
    }
    return { action: 'continue' };
  });
  /** What this session's lock tells peers: where it runs, whether it works, and its latest lines. */
  const share = (ctx: ExtensionContext, { turn, closing }: { turn?: string[]; closing?: boolean } = {}) => {
    const a = active;
    if (!a) return;
    try {
      const lines = [...a.memory.lastLines(4), ...(turn ?? turnLines(a.branch.dir)).map(line => `(this turn) ${line}`)].slice(-4);
      a.branch.setStatus({ cwd: ctx.cwd, pid: process.pid, created: a.branch.info.created, working, lines, ...closing ? { closing } : {} });
    }
    catch { /* a status is a courtesy */ }
  };
  const startRun = (ctx: ExtensionContext) => {
    flush(); run = []; logged = 0; keep = 0; view = undefined; runStarted = true; noted = new Set();
    const config = active?.config;
    previous = config?.previousExchange ? previousExchange(ctx.sessionManager.getBranch(), config.previousExchangeKB * 1000) : [];
    pi.appendEntry(RUN_BOUNDARY, { state: 'start' });
  };
  // A report sent while Pi is idle starts its run without before_agent_start; it reuses the last built prompt.
  pi.on('agent_start', (_event, ctx) => {
    working = true; showTitle(ctx); share(ctx);
    if (active && !runStarted) startRun(ctx);
  });
  pi.on('before_agent_start', (event, ctx) => {
    if (!active) return; // Plain Pi run: leave Pi's own prompt untouched.
    startRun(ctx);
    const a = required();
    // Pi's own prompt sections (AGENTS.md files, skills, cwd) stay; the profile's instructions go last.
    syncSearch(a.config);
    event.systemPromptOptions.customPrompt = allowSearch(`${MASTER}\n\n${modelsHint(a.config.subagent)}\n\n${PEERS_DOC}\n\n${VIEW_DOC}${a.config.previousExchange ? CONTINUITY : ''}${a.config.memorySearch ? SEARCH_DOC : ''}`, a.config.memorySearch);
    event.systemPromptOptions.sections.instructions = `${instructions(a.dir)}\n\n${IMPORT_GUIDANCE}`;
    refreshContextFiles(event.systemPromptOptions);
    prompt = event.systemPrompt;
  });
  const DUPLICATE_REPORT = '(duplicate report, already delivered)';
  pi.on('message_end', async (event, ctx) => {
    if (!active || !runStarted) return;
    const bounded = boundedMessage(event.message);
    const message = asUser(bounded);
    // Before the message is logged, so the image its text names is already there for zoom; zoom's own images are kept already.
    if (message.role === 'user' || message.role === 'toolResult' && message.toolName !== 'zoom') {
      try { await saveImages(active.memory.store, message.content); }
      catch (error) { ctx.ui.notify(`OptChat could not keep an image: ${errorText(error)}`, 'warning'); }
    }
    if (!active) return;
    if (message.role === 'user') {
      try {
        const text = textContent(message.content);
        // A report is shown as our custom message, or sent as plain text before the first run has a prompt to reuse.
        if (bounded.role === 'custom' && bounded.customType === REPORT_TYPE || reports.some(r => !r.batch && r.text === text)) {
          // A report sent again after a lost steer can still arrive twice (Pi kept the old steer after an abort): drop the extra copy.
          // Copies are counted, so a later report that happens to repeat an earlier text still arrives.
          const receipt = reportReceipt(text), copies = run.slice(logged).filter(m => receipts.get(m) === receipt).length;
          if (reports.filter(r => !r.batch && r.text === text).length <= copies && (copies > 0 || active.memory.root.some(e => e.receipt === receipt)))
            return { message: bounded.role === 'custom' ? { ...bounded, content: DUPLICATE_REPORT, display: false } : { ...message, content: DUPLICATE_REPORT } };
          receipts.set(message, receipt);
        } else {
          // The inbox journaled the typed input: match without image references or Pi's image notes.
          const typed = typedText(message.content), skill = parseSkillBlock(typed.bare);
          let receipt = active.inbox.claim(typed.text) ?? active.inbox.claim(typed.bare)
            ?? (skill ? active.inbox.claimSkill(skill.name, skill.userMessage) : undefined);
          if (!receipt) { active.inbox.record(text); receipt = active.inbox.claim(text); }
          if (receipt) receipts.set(message, receipt);
        }
      } catch (error) { ctx.abort(); fault = errorText(error); ctx.ui.notify(fault, 'error'); }
    }
    run.push(message);
    try { share(ctx, { turn: publishTurn(active.branch.dir, run).slice(-4) }); } catch { /* peers see less of this turn */ }
    if (view !== undefined) {
      try { flush(); } catch (error) { ctx.abort(); fault = errorText(error); ctx.ui.notify(fault, 'error'); }
    }
    if (bounded !== event.message) return { message: bounded };
  });
  pi.on('context_with_system', async (event, ctx) => {
    try {
      if (!active) return; // Plain Pi run: pass context through unmodified.
      const a = required();
      if (importing || pendingImport(a.dir)) throw new Error('Profile is unavailable while importing.');
      if (fault) throw new Error(fault);
      if (view === undefined) {
        // A misconfigured summarizer retries forever, so say why instead of spinning silently.
        let shown: string | undefined;
        const show = () => {
          const error = a.memory.lastError;
          const text = `Waiting for OptChat summaries…${error ? ` failing: ${oneLine(error)}${error.includes('/optchat') ? '' : ' (see /optchat model)'}` : ''}`;
          if (text !== shown) ctx.ui.setWorkingMessage(shown = text);
        };
        await rebase(a, ctx);
        if (fault) throw new Error(fault);
        show();
        const unsubscribe = a.memory.onChange(show);
        try { await a.memory.settle(ctx.signal); } finally { unsubscribe(); ctx.ui.setWorkingMessage(); }
        view = a.memory.render(); // Capture old history before logging the new input.
        flush();
      }
      // Extensions that run after ours (Pi's built-in MCP adds <mcp_servers>) still change the prompt; send what Pi has now.
      // A prompt without our preamble (a report run started while Pi was idle) keeps the last one we built.
      const current = ctx.getSystemPrompt();
      if (current.startsWith(MASTER.slice(0, 40))) prompt = current;
      // A turn past its budget moves its steps into the view, keeping the task and the last tool call whole (#146).
      const refresh = refreshPoint(run, keep, refreshBudget(ctx.model?.contextWindow, refreshFraction(a.config.refreshAt)));
      if (refresh) {
        const { cut, size } = refresh, began = Date.now();
        ctx.ui.setWorkingMessage(`OptChat: moving this turn's ${Math.round(size / 4000)}k tokens into memory…`);
        try { flush(); await a.memory.settle(ctx.signal); } finally { ctx.ui.setWorkingMessage(); }
        view = a.memory.render(); keep = cut;
        ctx.ui.notify(`OptChat moved ${Math.round(size / 4000)}k tokens of this turn into memory (${((Date.now() - began) / 1000).toFixed(1)}s).`, 'info');
      }
      // Built on every call, unlike the view, so it is never out of date; it goes last, after everything cached.
      return { messages: buildContext(event.messages, refreshedRun(run, keep, TURN_REFRESHED), view, promptFor(prompt, a.config), previous, atWork(a.children.working)) };
    } catch (error) {
      // Pi catches extension errors. Explicitly abort so it cannot fall back to old context.
      ctx.abort();
      try { flush(); } catch (persistenceError) { fault = errorText(persistenceError); }
      ctx.ui.notify(errorText(error), 'error');
      return { messages: [{ role: 'system', content: 'OptChat context unavailable. Stop.', timestamp: 0 }] };
    }
  });
  pi.on('before_provider_request', (event, ctx) => ctx.model?.api === 'anthropic-messages' ? cachePayload(event.payload) : event.payload);
  pi.on('cache_warming_decision', () => ({ action: 'stop' }));
  pi.on('session_before_compact', (_event, ctx) => {
    ctx.ui.notify('OptChat manages history between turns. Pi compaction is disabled; an exceptionally long single run may require stopping and continuing in a new turn.', 'info');
    return { cancel: true };
  });
  const collectUsage = (ctx: ExtensionContext) => {
    try { active?.usage.backfill(ctx.sessionManager.getEntries(), ctx.sessionManager.getSessionId()); }
    catch (error) { ctx.ui.notify(`Could not save usage: ${errorText(error)}`, 'error'); }
  };
  pi.on('turn_end', (_event, ctx) => collectUsage(ctx));
  pi.on('agent_settled', async (_event, ctx) => {
    collectUsage(ctx);
    try { flush(); active?.inbox.dropReturned(); } catch (error) { fault = errorText(error); ctx.ui.notify(fault, 'error'); }
    // A report steered into this run that never reached it (Esc or a dequeue cleared Pi's queue) is sent again, now as its own turn.
    if (active && !fault && !stopping) for (const r of reports) if (r.steered && !r.batch) sendReport(r);
    if (runStarted) pi.appendEntry(RUN_BOUNDARY, { state: 'end' });
    runStarted = false; status(ctx);
    working = false; showTitle(ctx);
    if (active) try { publishView(active.branch.dir, active.memory.render()); publishTurn(active.branch.dir, []); } catch { /* peers see the last one */ }
    share(ctx);
    if (active) {
      const dir = active.dir;
      // Sessions on the same profile take turns; one that finds another committing skips this checkpoint, and the next one covers it.
      checkpoints = checkpoints.then(async () => {
        let release: (() => Promise<void>) | undefined;
        try { release = await takeLock(lockPath(dir, 'checkpoint'), () => `checkpoint by PID ${process.pid}`); }
        catch (error) { if (error instanceof LockBusy) return; throw error; }
        try { await checkpoint(dir); } finally { await release(); }
      }).catch(error => ctx.ui.notify(`Local checkpoint failed: ${errorText(error)}`, 'error'));
      await checkpoints;
    }
  });
  registerReportRenderer(pi);
  const [zoom, date] = memoryTools(() => required().memory, id => required().children.transcript(id) ?? otherTranscript(required().dir, id));
  pi.registerTool(zoom); pi.registerTool(date);
  pi.registerTool({ ...searchTool(() => required().memory), defaultActive: false });
  // The tool and its prompt line change together, once per toggle, so the cached prefix is otherwise stable.
  // Synced on save too: a report turn started while idle reuses the tool set without before_agent_start.
  const syncSearch = ({ memorySearch }: ProfileConfig) => {
    const tools = pi.getActiveTools();
    if (tools.includes('search') !== memorySearch) pi.setActiveTools(memorySearch ? [...tools, 'search'] : tools.filter(name => name !== 'search'));
  };
  pi.registerTool({ name: 'spawn', label: 'Spawn background agents',
    description: 'Start background subagents, returning IDs immediately. Use only when the user asks. Give each task the cwd of the project it works on, so the subagent starts there with that project\'s AGENTS.md. Leave a task\'s model unset for the profile\'s default; name one only when the user asks, with an id from models(). Each receives the current memory view and read-only zoom/date. Whether children may delegate further, and how many agents may run at once, is set per profile. Completion reports arrive automatically; never poll or sleep waiting for them.',
    parameters: Type.Object({ tasks: TASKS }),
    async execute(_id, args, signal, _update, ctx) {
      const text = await required().children.start(args.tasks, ctx.cwd, signal); status(ctx);
      return result(text);
    },
  });
  pi.registerTool(modelsTool(() => required().children));
  pi.registerTool({ name: 'peers', label: 'Other sessions', description: 'List the other Pi sessions open on this profile right now: id, working directory, whether they are working, and their latest memory lines.',
    parameters: Type.Object({}),
    async execute() { const a = required(); return result(peersText(await livePeers(a.dir, a.branch.info.id))); },
  });
  pi.registerTool({ name: 'ask_peer', label: 'Ask another session', description: 'Ask a question about another open session (an id from peers). A cheap model answers from that session\'s memory view only; the session itself is not interrupted and never sees the question.',
    parameters: Type.Object({ id: Type.String(), question: Type.String() }),
    async execute(_id, args, signal, _update, ctx) {
      const a = required();
      const answer = await askPeer(a.dir, a.branch.info.id, args.id, args.question, ctx.modelRegistry, a.config.compactor,
        message => { a.usage.compression(message, 'compactor', ctx.sessionManager.getSessionId()); }, signal);
      return result(answer);
    },
  });
  pi.registerTool({ name: 'note_peer', label: 'Note to another session', description: 'Leave a short note (at most 280 bytes) for another open session (an id from peers). It is added to the end of that session\'s next input; it never starts a turn there and gets no reply. One note per session per turn.',
    parameters: Type.Object({ id: Type.String(), text: Type.String() }),
    async execute(_id, args, _signal, _update, ctx) {
      const a = required();
      if (noted.has(args.id)) throw new Error(`You already left ${args.id} a note this turn. Put everything in one note.`);
      // Taken before the write: tool calls in one message run at once, and the second must already see the first.
      const turn = noted; turn.add(args.id);
      try { await notePeer(a.dir, { id: a.branch.info.id, cwd: ctx.cwd }, args.id, args.text); }
      catch (error) { turn.delete(args.id); throw error; }
      return result(`Noted. ${args.id} sees it at the end of its next input.`);
    },
  });
  pi.registerTool({ name: 'tell', label: 'Tell background agent', description: 'Send a message to a subagent. A running one gets it at its next tool boundary. A finished one you started is resumed with its earlier conversation, and its new report arrives automatically.',
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    async execute(_id, args) { return result(await required().children.tell(args.id, args.message)); },
  });

  /** The settings page's options: every model Pi is logged in to, with the thinking levels it takes, sorted so each provider's models sit together. */
  const settingsOptions = (ctx: ExtensionContext, a: Active) => ({ profile: a.name, config: a.config,
    models: ctx.modelRegistry.getAvailable().map(m => ({ name: `${m.provider}/${m.id}`, thinking: getSupportedThinkingLevels(m) })).sort((x, y) => x.name.localeCompare(y.name)),
    save: (config: ProfileConfig) => { saveConfig(a.dir, config); syncSearch(config); } });
  const pickModel = async (ctx: ExtensionContext, role: 'compactor' | 'subagent') => {
    const a = required();
    if (ctx.mode !== 'tui') throw new Error('Choosing a model requires interactive Pi. Edit config.json in the profile directory instead.');
    const choice = await showModelPicker(ctx, role, settingsOptions(ctx, a));
    if (choice) ctx.ui.notify(`${role}: ${choice.provider}/${choice.model} (${choice.thinking}); applies to new calls.`, 'info');
  };
  const inspect = async (ctx: ExtensionContext, page: InspectorPage) => {
    if (inspectorController) return;
    const controller = new AbortController();
    try {
      const a = required();
      if (ctx.mode !== 'tui') throw new Error('The inspector requires interactive Pi.');
      if (importing) throw new Error('Close the import dialog before opening the inspector.');
      inspectorController = controller;
      const signal = inspectorController.signal;
      const action = await showInspector(ctx, { profile: a.name, session: ctx.sessionManager.getSessionId(), children: a.children, usage: a.usage, memory: a.memory, page, signal,
        refreshUsage: () => { collectUsage(ctx); try { a.children.collectUsage(); } catch (error) { ctx.ui.notify(`Could not save child usage: ${errorText(error)}`, 'error'); } },
      });
      if (signal.aborted) return;
      if (action === 'model') await pickModel(ctx, 'subagent');
      else if (action) await showAgentView(ctx, { id: action.open, children: a.children, signal });
    } catch (error) { ctx.ui.notify(errorText(error), 'error'); }
    finally { if (inspectorController === controller) inspectorController = undefined; }
  };
  pi.registerShortcut(shortcut, { description: 'Inspect OptChat agents, usage and background activity', handler: ctx => inspect(ctx, 'agents') });
  const command = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (importing) throw new Error('Close the import dialog before changing profile settings.');
    let action = args.trim();
    if (!action) {
      const a = active;
      action = await showMenu(ctx, brand, a && { profile: a.name, messages: a.memory.root.length, pending: a.memory.pending,
        compactor: a.config.compactor, agents: a.config.subagent, error: a.memory.lastError }) ?? '';
    }
    if (action === 'import') {
      const a = required();
      if (!ctx.hasUI) throw new Error('/optchat import requires interactive Pi.');
      if (!ctx.isIdle() || a.children.active || reports.length) throw new Error('Finish active work and pending reports before importing.');
      // An import rebuilds the shared memory every session branches from, so it runs only with this session open.
      // Crashed sessions are merged first: one left unmerged could never merge into the new memory.
      await recoverBranches(a.dir, warning => ctx.ui.notify(warning, 'warning'));
      const others = listBranches(a.dir).filter(b => !b.closed && b.id !== a.branch.info.id).map(b => b.id);
      if (others.length) throw new Error(`Close the other sessions on ${a.name} first (${others.join(', ')}): an import rewrites the memory they share.`);
      importing = true; importController = new AbortController(); let closed = false;
      status(ctx);
      const signal = importController.signal;
      importTask = (async () => {
        let job = pendingImport(a.dir);
        if (job) {
          const selected = await ctx.ui.select(`Paused ${job.mode} import · ${job.added} new messages`, ['Resume import', 'Discard staged import', 'Cancel'], { signal });
          if (selected === 'Discard staged import') {
            if (await ctx.ui.confirm('Discard import?', 'Original memory stays unchanged. Staged summaries will be removed.', { signal })) { signal.throwIfAborted(); discardImport(a.dir); }
            return;
          }
          if (selected !== 'Resume import') return;
        } else {
          const plan = await chooseImport(ctx, a.name, a.memory, `${a.config.compactor.provider}/${a.config.compactor.model} (${a.config.compactor.thinking})`, signal);
          if (!plan) return;
          signal.throwIfAborted();
          flush(); a.inbox.recover(a.memory); await checkpoints; await a.memory.close(); closed = true;
          await closeBranch(a);
          signal.throwIfAborted();
          // The import builds on the trunk, which now has everything this session said.
          const trunk = new Memory(memoryDirectory(a.dir), () => Promise.reject(new Error('not summarizing')), warning => ctx.ui.notify(warning, 'warning'), undefined, 0);
          try { job = prepareImport(a.dir, trunk, plan.entries, plan.mode); } finally { await trunk.close(); }
          if (!job) return;
        }
        if (!closed) { await a.memory.close(); closed = true; await closeBranch(a); }
        const compress = createCompressor(ctx.modelRegistry, () => a.config.compactor, message => {
          a.usage.compression(message, 'import', ctx.sessionManager.getSessionId());
        }, () => a.config.summaryAcceptBytes);
        const completed = await showProgress(ctx, job, (signal, progress) => runImport(a.dir, compress, signal, a.config.jobs, progress), signal);
        ctx.ui.notify(completed ? `Imported ${job.added} messages into ${a.name}. Previous memory retained at ${job.previous === '.' ? a.dir : join(a.dir, job.previous)}.`
          : 'Import paused. Use /optchat import to resume. Other profiles remain available.', 'info');
      })();
      let failure: unknown;
      try { await importTask; } catch (error) { failure = error; }
      finally { importing = false; importTask = undefined; importController = undefined; ctx.ui.setWidget('optchat-import', undefined); }
      if (closed && !stopping) await ctx.newSession({ setup: async manager => { manager.appendCustomEntry(binding, { name: a.name }); } });
      else status(ctx);
      if (failure) throw failure;
      return;
    }
    const named = /^profile\s+(\S+)$/.exec(action)?.[1];
    if (ctx.mode !== 'tui' && (named || action === 'profile')) {
      // RPC and SDK hosts (Pi Web) have no picker and may not support ctx.newSession(), so a still-empty session binds in place.
      const first = `Run /optchat profile ${named ?? '<name>'} as the first message of a new session, or start Pi with --optchat-profile <name>.`;
      if (!named || active || ctx.sessionManager.getEntries().some(e => e.type === 'message' || e.type === 'custom_message')) throw new Error(first);
      // As with a requested profile: one that fails to open blocks prompts instead of running without memory.
      try { await openProfile(named, ctx); } catch (error) { fault = errorText(error); throw error; }
      pi.appendEntry(binding, { name: named });
      return;
    }
    if (action === 'profile') {
      if (!ctx.isIdle() || active?.children.active) throw new Error('Finish or stop active work before switching profiles.');
      const selected = await chooseProfile(ctx);
      if (!selected || selected === active?.name) return;
      await ctx.newSession({ setup: async manager => { manager.appendCustomEntry(binding, { name: selected }); } });
      return;
    }
    if (action === 'settings') {
      const a = required();
      if (ctx.mode !== 'tui') throw new Error('/optchat settings requires interactive Pi. Edit config.json in the profile directory instead.');
      return showSettings(ctx, settingsOptions(ctx, a));
    }
    if (action === 'model') return pickModel(ctx, 'compactor');
    if (action === 'agents model') return pickModel(ctx, 'subagent');
    if (action === 'agents' || action === 'usage' || action === 'activity') return inspect(ctx, action);
    if (action === 'instructions') {
      const a = required();
      const edited = await ctx.ui.editor(`${a.name} · AGENTS.md`, instructions(a.dir));
      if (edited !== undefined) { atomicWrite(join(a.dir, 'AGENTS.md'), edited); ctx.ui.notify('Saved. Applies to the next turn and newly spawned agents.', 'info'); }
      return;
    }
    if (action === 'browse') {
      const a = required(), file = exportBrowser(a.memory, a.name, a.dir);
      // explorer.exe exits 1 even when it opened the file, so only its launch failing counts there.
      if (ctx.hasUI) execFile(isWindows ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', [file], error => { if (error && (!isWindows || error.code === 'ENOENT')) ctx.ui.notify(`Open ${file}`, 'info'); });
      ctx.ui.notify(file, 'info'); return;
    }
    if (action) throw new Error('Use /optchat [profile|settings|model|agents|usage|activity|instructions|browse|import].');
  };
  pi.registerCommand('optchat', { description: 'OptChat profiles, settings, models, agents, instructions, memory browser, and imports',
    getArgumentCompletions: prefix => ['profile', 'settings', 'model', 'agents', 'agents model', 'usage', 'activity', 'instructions', 'browse', 'import'].filter(s => s.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => { try { await command(args, ctx); } catch (error) { ctx.ui.notify(errorText(error), 'error'); } },
  });
}
