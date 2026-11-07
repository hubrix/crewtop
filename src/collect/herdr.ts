// Reads `herdr agent list` and nothing else from Herdr. The same JSON carries
// terminal titles derived from the conversation and working directories, so only
// the four allowlisted fields below are ever touched.
import { execFile } from 'node:child_process';
import { closedAgentName, OTHER_AGENT } from '../agents.ts';
import { SEAT, STATES } from '../wire.ts';
import type { LiveAgent, State } from '../wire.ts';
import { sessionKey } from './salt.ts';
import type { Keyer } from './salt.ts';

const HERDR_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function runHerdrList(bin = 'herdr'): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['agent', 'list'], { timeout: HERDR_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

/** Maps Herdr's JSON to live rows, or returns null when it is not the expected shape. */
export function parseHerdrList(text: string, keyer: Keyer): LiveAgent[] | null {
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
    const sessionId = (raw.agent_session as { value?: unknown } | null | undefined)?.value;
    const seat = typeof paneId === 'string' && SEAT.test(paneId) ? paneId : undefined;
    const row: LiveAgent = {
      k:
        typeof sessionId === 'string' && sessionId !== ''
          ? sessionKey(keyer, sessionId)
          : keyer(`pane:${typeof paneId === 'string' ? paneId : ''}`),
      a: closedAgentName(agent) ?? OTHER_AGENT,
      st: STATES.includes(status as State) ? (status as State) : 'unknown',
      src: 'herdr',
    };
    if (seat) row.seat = seat;
    return row;
  });
}
