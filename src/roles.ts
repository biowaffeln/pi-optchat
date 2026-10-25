import { record } from './cache.ts';
import { THINKING } from './profiles.ts';

export const TOOL_SETS = ['all', 'readonly'] as const;
export type ToolSet = typeof TOOL_SETS[number];
export type Thinking = typeof THINKING[number];
/** A named preset for spawn tasks. What it leaves out falls back to the profile's subagent choice and the spawn defaults. */
export interface Role { description: string; model?: string; thinking?: Thinking; tools?: ToolSet; memory?: boolean }
export type Roles = Record<string, Role>;

/** Used when a profile's config.json has no `roles`; a `roles` object there replaces this list as a whole. */
export const DEFAULT_ROLES: Roles = {
  scout: { description: 'Fast read-only recon: finding files, tracing symbols, mapping unfamiliar code.', model: 'openai-codex/gpt-6-luna', thinking: 'low', tools: 'readonly', memory: false },
  implementer: { description: 'Executes a well-specified brief: writes code, runs tests, commits.', tools: 'all' },
  reviewer: { description: 'Reviews diffs, branches or modules for bugs, design issues and risky assumptions.', model: 'anthropic/claude-opus-5-5', thinking: 'high', tools: 'readonly' },
  elder: { description: 'The hardest reasoning: design decisions, subtle correctness, debugging that resisted earlier attempts.', model: 'anthropic/claude-opus-5-5', thinking: 'xhigh', tools: 'readonly' },
};

const ROLE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Why a `roles` value can't be used, or undefined if it can. */
export function invalidRoles(value: unknown): string | undefined {
  if (!record(value)) return 'roles must be an object of role names to roles.';
  for (const [name, role] of Object.entries(value)) {
    const where = `Role ${name}`;
    if (!ROLE_NAME.test(name)) return `${where}: names are 1–32 lowercase letters, digits, hyphens or underscores.`;
    if (!record(role)) return `${where} must be an object.`;
    if (typeof role.description !== 'string' || !role.description.trim()) return `${where} needs a description.`;
    if (role.model !== undefined && (typeof role.model !== 'string' || !/^[^/\s]+\/\S+$/.test(role.model))) return `${where}: model must be provider/id.`;
    if (role.thinking !== undefined && !THINKING.some(level => level === role.thinking)) return `${where}: thinking must be one of ${THINKING.join(', ')}.`;
    if (role.tools !== undefined && !TOOL_SETS.some(set => set === role.tools)) return `${where}: tools must be all or readonly.`;
    if (role.memory !== undefined && typeof role.memory !== 'boolean') return `${where}: memory must be true or false.`;
    const unknown = Object.keys(role).find(key => !['description', 'model', 'thinking', 'tools', 'memory'].includes(key));
    if (unknown) return `${where}: unknown key ${unknown}.`;
  }
  return undefined;
}

/** The roles a spawn task may name, one per line, for the agent's prompt. */
export function rolesDoc(roles: Roles) {
  const names = Object.keys(roles);
  if (!names.length) return '';
  const line = (name: string, { description, model, thinking, tools, memory }: Role) => {
    const facts = [model ?? 'subagent model', thinking && `thinking ${thinking}`, tools === 'readonly' && 'read-only', memory === false && 'no memory'].filter(Boolean).join(', ');
    return `- ${name} (${facts}): ${description}`;
  };
  return `Spawn roles: a task's role sets its model, thinking, tools and memory in one go. Pick one freely when it fits the task; fields you set on the task override it.\n${names.map(name => line(name, roles[name])).join('\n')}`;
}
