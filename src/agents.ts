// The closed list of agent names that may cross the wire. A name that is not
// here is never forwarded: Herdr rows become OTHER_AGENT, process rows are dropped.

/** Agents ccusage 20.0.48 can read. These may have token numbers. */
export const CCUSAGE_AGENTS = [
  'claude',
  'codex',
  'opencode',
  'amp',
  'droid',
  'codebuff',
  'hermes',
  'pi',
  'goose',
  'kilo',
  'copilot',
  'gemini',
  'antigravity',
  'kimi',
  'qwen',
  'openclaw',
  'grok',
  'zcode',
] as const;

/** Agents with no ccusage adapter. Their tokens show as n/a, never 0. */
export const UNCOVERED_AGENTS = [
  'dsh-tui',
  'kiro',
  'muse',
  'omp',
  'cursor',
  'devin',
  'cline',
  'mastracode',
  'qodercli',
  'letta',
  'maki',
] as const;

/** A Herdr agent whose name is off the list: real liveness, name withheld. */
export const OTHER_AGENT = 'other';

const ALIASES: ReadonlyMap<string, string> = new Map([['agy', 'antigravity']]);

const COVERED: ReadonlySet<string> = new Set(CCUSAGE_AGENTS);
const KNOWN: ReadonlySet<string> = new Set([...CCUSAGE_AGENTS, ...UNCOVERED_AGENTS]);
const WIRE_NAMES: ReadonlySet<string> = new Set([...KNOWN, OTHER_AGENT]);

/** Returns the closed-list name for a raw name, or null when it is not listed. */
export function closedAgentName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = ALIASES.get(raw) ?? raw;
  return KNOWN.has(name) ? name : null;
}

export function isWireAgent(name: unknown): boolean {
  return typeof name === 'string' && WIRE_NAMES.has(name);
}

export function isCoveredByCcusage(name: string): boolean {
  return COVERED.has(name);
}
