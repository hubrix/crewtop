// Reads `herdr agent list` and nothing else from Herdr, once for the server a plain
// call reaches and once for each other running session that `herdr session list`
// names. The agent JSON carries terminal titles derived from the conversation and
// working directories, so only the four allowlisted fields below are ever touched.
// Session names and socket paths stay on this machine: they only pick a socket and
// scope a key that leaves as an HMAC.
import { execFile } from 'node:child_process';
import { closedAgentName, OTHER_AGENT } from '../agents.ts';
import { SEAT, STATES } from '../wire.ts';
import type { LiveAgent, State } from '../wire.ts';
import { sessionKey } from './salt.ts';
import type { Keyer } from './salt.ts';

const HERDR_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** More sessions than this on one machine are ignored, so one read stays bounded. */
export const MAX_HERDR_SESSIONS = 16;

function runHerdr(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, socket?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const childEnv = socket === undefined ? env : { ...env, HERDR_SOCKET_PATH: socket };
    execFile(bin, args, { env: childEnv, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

/** Runs `herdr agent list`, against `socket` when given, or the server a plain call reaches. */
export function runHerdrList(bin = 'herdr', socket?: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = HERDR_TIMEOUT_MS): Promise<string | null> {
  return runHerdr(bin, ['agent', 'list'], env, timeoutMs, socket);
}

export interface HerdrSession {
  name: string;
  socket: string;
}

/**
 * Picks the running sessions a plain `herdr agent list` does not already read, from
 * `herdr session list --json`. `plainSocket` is the inherited HERDR_SOCKET_PATH; without
 * it, a plain call reads the default session. Anything unexpected yields no sessions.
 */
export function parseHerdrSessions(text: string, plainSocket?: string): HerdrSession[] {
  let parsed: { sessions?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const sessions = parsed?.sessions;
  if (!Array.isArray(sessions)) return [];
  const running = sessions.filter(
    (s: Record<string, unknown> | null): s is { name: string; socket_path: string; default?: unknown } =>
      typeof s === 'object' &&
      s !== null &&
      s.running === true &&
      typeof s.name === 'string' &&
      s.name !== '' &&
      typeof s.socket_path === 'string' &&
      s.socket_path !== '',
  );
  const plain = plainSocket || running.find((s) => s.default === true)?.socket_path;
  return running
    .filter((s) => s.socket_path !== plain)
    .slice(0, MAX_HERDR_SESSIONS)
    .map((s) => ({ name: s.name, socket: s.socket_path }));
}

/**
 * Returns the session id ccusage reports for Herdr's `agent_session`, or undefined.
 * Herdr names a pi session by its transcript path, `<dir>/<timestamp>_<uuid>.jsonl`;
 * ccusage's pi adapter reports the same session as `<uuid>`, the part of the file name
 * after the last `_`, which is also the id in the transcript's session header. Every
 * other session keeps its value as Herdr gives it.
 */
export function herdrSessionId(agent: unknown, session: unknown): string | undefined {
  const { kind, value } = (session ?? {}) as { kind?: unknown; value?: unknown };
  if (typeof value !== 'string' || value === '') return undefined;
  if (kind !== 'path' || agent !== 'pi') return value;
  const file = value.slice(value.lastIndexOf('/') + 1).replace(/\.jsonl$/, '');
  return file.slice(file.lastIndexOf('_') + 1) || undefined;
}

/**
 * Maps Herdr's JSON to live rows, or returns null when it is not the expected shape.
 * `scope` names the session the rows came from, so two sessions' panes with the same
 * id key apart. Session-id keys need no scope: they join with ccusage across sessions.
 */
export function parseHerdrList(text: string, keyer: Keyer, scope?: string): LiveAgent[] | null {
  let parsed: { result?: { agents?: unknown } };
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const agents = parsed?.result?.agents;
  if (!Array.isArray(agents)) return null;
  return agents.map((raw: Record<string, unknown>) => {
    const { agent, agent_status: status, pane_id: paneId } = raw;
    const sessionId = herdrSessionId(agent, raw.agent_session);
    const seat = typeof paneId === 'string' && SEAT.test(paneId) ? paneId : undefined;
    const pane = typeof paneId === 'string' ? paneId : '';
    const row: LiveAgent = {
      k:
        sessionId !== undefined
          ? sessionKey(keyer, sessionId)
          : keyer(scope === undefined ? `pane:${pane}` : `pane@${scope}:${pane}`),
      a: closedAgentName(agent) ?? OTHER_AGENT,
      st: STATES.includes(status as State) ? (status as State) : 'unknown',
      src: 'herdr',
    };
    if (seat) row.seat = seat;
    return row;
  });
}

/**
 * Reads every local Herdr session and counts each agent once, first sighting winning.
 * A session that is missing, stopped or answers badly is skipped. All calls share one
 * 5 s deadline, so a read takes no longer than the single call it replaces. Returns
 * null only when no session answered.
 */
export async function readHerdr(keyer: Keyer, bin = 'herdr', env: NodeJS.ProcessEnv = process.env): Promise<LiveAgent[] | null> {
  const deadline = Date.now() + HERDR_TIMEOUT_MS;
  const plain = runHerdrList(bin, undefined, env).then((raw) => (raw === null ? null : parseHerdrList(raw, keyer)));
  const named = runHerdr(bin, ['session', 'list', '--json'], env, HERDR_TIMEOUT_MS).then((listing) => {
    const sessions = listing === null ? [] : parseHerdrSessions(listing, env.HERDR_SOCKET_PATH);
    return Promise.all(
      sessions.map(async ({ name, socket }) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        const raw = await runHerdrList(bin, socket, env, remaining);
        return raw === null ? null : parseHerdrList(raw, keyer, name);
      }),
    );
  });
  const results = [await plain, ...(await named)];
  if (results.every((rows) => rows === null)) return null;
  const seen = new Set<string>();
  const merged: LiveAgent[] = [];
  for (const row of results.flatMap((rows) => rows ?? [])) {
    if (seen.has(row.k)) continue;
    seen.add(row.k);
    merged.push(row);
  }
  return merged;
}
