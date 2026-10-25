import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ModelChoice } from './compactor.ts';
import { record } from './cache.ts';
import { atomicWrite } from './store.ts';
import { DEFAULT_SETTINGS, readSettings, type Settings } from './settings.ts';

export const isWindows = process.platform === 'win32';

export const dataHome = () => resolve(process.env.OPTCHAT_HOME ?? join(homedir(), '.optchat'));
/** `main` is the last model and thinking level picked in Pi while this profile was open; absent until one is picked. */
export interface ProfileConfig extends Settings { compactor: ModelChoice; subagent: ModelChoice; main?: ModelChoice }
export const defaults: ProfileConfig = {
  compactor: { provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'medium' },
  subagent: { provider: 'anthropic', model: 'claude-opus-5-5', thinking: 'high' },
  ...DEFAULT_SETTINGS,
};
export const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export function profilePath(name: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Profile names: 1–64 lowercase letters, digits, hyphens, or underscores.');
  return join(dataHome(), 'profiles', name);
}
export function listProfiles() {
  const root = join(dataHome(), 'profiles');
  return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(f => f.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(f.name)).map(f => f.name).sort() : [];
}
export function createProfile(name: string) {
  const dir = profilePath(name);
  if (existsSync(dir)) throw new Error(`Profile already exists: ${name}`);
  mkdirSync(resolve(dir, '..'), { recursive: true, mode: 0o700 });
  // Claim the directory exclusively, so a competing creator cannot have its
  // profile overwritten or removed by this attempt's cleanup.
  mkdirSync(dir, { mode: 0o700 });
  try {
    saveConfig(dir, defaults);
    atomicWrite(join(dir, 'AGENTS.md'), `# ${name}\n\nThis is the ${name} profile.\nAdd your personal instructions here.\n`);
  } catch (error) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
    catch { throw new Error(`Failed to create profile ${name}, and could not remove its incomplete directory: ${dir}`, { cause: error }); }
    throw error;
  }
}
export function saveConfig(dir: string, config: ProfileConfig) { atomicWrite(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n'); }
function modelChoice(value: unknown): value is ModelChoice {
  return record(value) && typeof value.provider === 'string' && typeof value.model === 'string'
    && THINKING.some(level => level === value.thinking);
}
export function loadConfig(dir: string): ProfileConfig {
  const value: unknown = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  if (!record(value) || !modelChoice(value.compactor) || !modelChoice(value.subagent) || value.main !== undefined && !modelChoice(value.main)) throw new Error(`Invalid profile config: ${dir}/config.json`);
  const { compactor, subagent, main } = value;
  try { return { compactor, subagent, ...main && { main }, ...readSettings(value) }; }
  catch (error) { throw new Error(`Invalid profile config: ${dir}/config.json: ${error instanceof Error ? error.message : String(error)}`); }
}
export function instructions(dir: string) { return readFileSync(join(dir, 'AGENTS.md'), 'utf8'); }
export function lastProfile() {
  try { const name = readFileSync(join(dataHome(), 'last-profile'), 'utf8').trim(); return listProfiles().includes(name) ? name : undefined; }
  catch { return undefined; }
}
export function rememberProfile(name: string) { atomicWrite(join(dataHome(), 'last-profile'), name); }
