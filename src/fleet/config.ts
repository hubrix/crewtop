// The fleet member list. The format is the small subset of TOML this file needs,
// parsed here because crewtop has one runtime dependency and it is ccusage:
//
//   [[member]]
//   name = "box-b"
//   ssh = "box-b"
//
// Anything outside the subset is an error with a line number. A typo must not
// silently drop a machine from the dashboard.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { SAFE_STRING } from '../wire.ts';

export interface Member {
  /** Display name. Null only for the local view with no config, which uses the host's own name. */
  name: string | null;
  /** SSH destination, or null for the machine crewtop runs on. */
  ssh: string | null;
}

export const LOCAL_ONLY: Member[] = [{ name: null, ssh: null }];

/** A host or alias, optionally with a user. It cannot start with `-`, so ssh cannot read it as an option. */
const SSH_TARGET = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TABLE = /^\[\[\s*member\s*\]\]$/;
const STRING_PAIR = /^([A-Za-z_]+)\s*=\s*"([^"\\]*)"$/;
const BOOLEAN_PAIR = /^([A-Za-z_]+)\s*=\s*(true|false)$/;

export class FleetConfigError extends Error {}

/** Removes a trailing comment. The subset has no `\"`, so a `#` inside quotes is the only special case. */
function stripComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === '#' && !quoted) return line.slice(0, i);
  }
  return line;
}

interface Draft {
  line: number;
  name?: string;
  ssh?: string;
  local?: boolean;
}

function finishMember(draft: Draft): Member {
  const where = `line ${draft.line}`;
  if (draft.name === undefined) throw new FleetConfigError(`${where}: member has no name`);
  if (!SAFE_STRING.test(draft.name)) throw new FleetConfigError(`${where}: name must match ${SAFE_STRING.source}`);
  const local = draft.local === true;
  if (local && draft.ssh !== undefined) throw new FleetConfigError(`${where}: member "${draft.name}" sets both local and ssh`);
  if (local) return { name: draft.name, ssh: null };
  if (draft.ssh === undefined) throw new FleetConfigError(`${where}: member "${draft.name}" needs ssh = "<target>" or local = true`);
  if (!SSH_TARGET.test(draft.ssh)) throw new FleetConfigError(`${where}: member "${draft.name}" has an invalid ssh target`);
  return { name: draft.name, ssh: draft.ssh };
}

export function parseFleetConfig(text: string): Member[] {
  const drafts: Draft[] = [];
  text.split('\n').forEach((raw, index) => {
    const number = index + 1;
    const line = stripComment(raw).trim();
    if (line === '') return;
    if (TABLE.test(line)) {
      drafts.push({ line: number });
      return;
    }
    const draft = drafts[drafts.length - 1];
    if (!draft) throw new FleetConfigError(`line ${number}: expected [[member]]`);
    const text = STRING_PAIR.exec(line);
    const flag = BOOLEAN_PAIR.exec(line);
    const key = text?.[1] ?? flag?.[1];
    if (key === undefined) throw new FleetConfigError(`line ${number}: expected key = "value"`);
    if (Object.hasOwn(draft, key)) throw new FleetConfigError(`line ${number}: ${key} is set twice`);
    if (key === 'local' && flag) draft.local = flag[2] === 'true';
    else if (key === 'name' && text) draft.name = text[2]!;
    else if (key === 'ssh' && text) draft.ssh = text[2]!;
    else throw new FleetConfigError(`line ${number}: unknown or mistyped key ${key}`);
  });

  const members = drafts.map(finishMember);
  if (members.length === 0) throw new FleetConfigError('no [[member]] entries');
  const names = new Set<string>();
  for (const { name } of members) {
    if (names.has(name!)) throw new FleetConfigError(`member name "${name}" is used twice`);
    names.add(name!);
  }
  if (members.filter((member) => member.ssh === null).length > 1) throw new FleetConfigError('more than one member sets local = true');
  return members;
}

export function defaultFleetConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(env.HOME || homedir(), '.config');
  return join(base, 'crewtop', 'fleet.toml');
}

/** Reads and parses a config. Returns null only when `missingIsOk` and the file does not exist. */
export function loadFleetConfig(path: string, missingIsOk = false): Member[] | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (missingIsOk && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new FleetConfigError('cannot read the file');
  }
  return parseFleetConfig(text);
}
