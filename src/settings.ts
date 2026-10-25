import { NODE } from './memory.ts';

/** Per-profile choices where OptChat departs from Victor's recipe. Each default is the recipe's behaviour unless noted. */
export const SETTINGS = {
  subagentLevels: { kind: 'number', label: 'Subagent levels', default: 1, min: 1, unit: '',
    description: 'How many levels of subagents. 1: only the main agent starts subagents. 2: those subagents may start their own, and so on.',
    applies: 'Applies to subagents started or resumed after this.' },
  maxAgents: { kind: 'number', label: 'Max active agents', default: 8, min: 1, unit: '',
    description: 'Subagents running at once in this profile, all levels together. It also caps how deep a chain can go.',
    applies: 'Applies to the next spawn.' },
  groupReports: { kind: 'toggle', label: 'Group subagent reports', default: false,
    description: 'Off: each subagent reports as soon as it finishes, as in Victor\'s recipe. On: the subagents started by one spawn report together, in one message once the last of them finishes.',
    applies: 'Applies to the next spawn.' },
  previousExchange: { kind: 'toggle', label: 'Previous exchange', default: true,
    description: 'Send your last request and its answer in full with the next turn, so a follow-up reads the exact wording. Off: memory view only, as in Victor\'s recipe. On by default: a study found it costs little and saves zooms.',
    applies: 'Applies from the next turn.' },
  previousExchangeKB: { kind: 'number', label: 'Previous exchange limit', default: 16, min: 1, unit: 'KB',
    description: 'A larger last exchange, usually a big paste, is left out and the model zooms into memory instead.',
    applies: 'Applies from the next turn.' },
  memorySearch: { kind: 'toggle', label: 'Memory search', default: false,
    description: 'Give agents a search tool that finds original messages by plain text, newest first, for exact names, numbers, paths or errors the view doesn\'t show. Off: zoom and date only, as in Victor\'s recipe. Turning it on or off makes the next turn re-cache its prompt once.',
    applies: 'Applies from the next turn, and to subagents started or resumed after this.' },
  summaryAcceptBytes: { kind: 'number', label: 'Summary size tolerance', default: NODE * 1.25, min: NODE, unit: 'bytes',
    description: `The compactor is always asked for ${NODE}-byte lines; a longer line up to this size is kept instead of retried. ${NODE}: strict, as in Victor's recipe. The default saves retries for a little more view space.`,
    applies: 'Applies to the next summary.' },
  jobs: { kind: 'number', label: 'Summaries at once', default: 8, min: 1, max: 64, unit: '',
    description: 'Summaries built at once, by chat compaction and by an import. With N at once, a summary can see up to N−1 lines not summarized yet before it, so higher is faster but a little less accurate (at 8 that costs about 0.8 points per summary, #108). Higher also hits your provider\'s rate limits harder; the compactor retries what is refused. If your provider caps parallel requests, set it below that cap so the main turn has room.',
    applies: 'Applies to the next import, and to chat once the profile opens again (e.g. after /reload).' },
  idleMergeMinutes: { kind: 'number', label: 'Merge when idle', default: 30, min: 0, max: 1440, unit: 'min',
    description: 'Every Pi session on a profile is a branch of its shared memory, and merges what it said into that memory when it closes. A session left open with nothing new for this many minutes merges too, so other sessions started after that can see it. 0: merge only on close.',
    applies: 'Applies at once.' },
  refreshAt: { kind: 'percent', label: 'Turn refresh threshold', default: 0.3, min: 0, max: 0.9,
    description: 'Once the current turn\'s messages pass this share of the model\'s context window, they move into memory and the turn goes on with a fresh window: the rebuilt view, the task word for word, and its last tool call and result. 0%: off, as in Victor\'s recipe, and a long turn can run out of window. OPTCHAT_REFRESH_AT (a fraction, e.g. 0.3; 0 is off) overrides it. Subagents use Pi\'s own compaction at about the same point.',
    applies: 'Applies from the next call, and to subagents started or resumed after this.' },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type Settings = { -readonly [K in SettingKey]: (typeof SETTINGS)[K]['default'] extends boolean ? boolean : number };
export type NumberKey = { [K in SettingKey]: Settings[K] extends number ? K : never }[SettingKey];
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const isNumberKey = (key: SettingKey): key is NumberKey => SETTINGS[key].kind !== 'toggle';
/** A percent setting is saved as a fraction of 1 and shown as a percentage. */
export const percent = (fraction: number) => `${Math.round(fraction * 1000) / 10}%`;

/** Why a value can't be used, or undefined if it can. Numbers are whole and within their range. */
export function invalid(key: SettingKey, value: unknown) {
  if (isNumberKey(key)) {
    const spec = SETTINGS[key];
    if (spec.kind === 'percent') return typeof value === 'number' && value >= spec.min && value <= spec.max ? undefined
      : `${spec.label} must be from ${percent(spec.min)} to ${percent(spec.max)}.`;
    const { label, min, max = Infinity }: { label: string; min: number; max?: number } = spec;
    return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max ? undefined
      : `${label} must be a whole number ${max === Infinity ? `of ${min} or more` : `from ${min} to ${max}`}.`;
  }
  return typeof value === 'boolean' ? undefined : `${SETTINGS[key].label} must be true or false.`;
}

/** Missing keys take their defaults, so config files written before a setting existed keep working. */
export function readSettings(value: Record<string, unknown>): Settings {
  // "Summaries at once" was `importJobs` while it only covered imports; an older config.json keeps its value.
  if (!Object.hasOwn(value, 'jobs') && Object.hasOwn(value, 'importJobs')) value = { ...value, jobs: value.importJobs };
  return Object.fromEntries(SETTING_KEYS.map(key => {
    const raw = Object.hasOwn(value, key) ? value[key] : SETTINGS[key].default, problem = invalid(key, raw);
    if (problem) throw new Error(problem);
    return [key, raw];
  })) as Settings;
}
export const DEFAULT_SETTINGS = readSettings({});
