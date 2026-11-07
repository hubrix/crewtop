// Session ids are resume handles, so they leave the machine only as a truncated
// HMAC under a salt that stays on this host at mode 0600.
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function saltPath(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state');
  return join(state, 'crewtop', 'salt');
}

export function loadSalt(path: string = saltPath()): Buffer {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
  }
  return readFileSync(path);
}

const TRAILING_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reduces a session id to its joinable form. ccusage reports Codex sessions as a
 * rollout path that ends in the UUID, so the UUID is the id Herdr would also hold.
 */
export function joinId(sessionId: string): string {
  return sessionId.match(TRAILING_UUID)?.[0].toLowerCase() ?? sessionId;
}

export type Keyer = (identity: string) => string;

export function makeKeyer(salt: Buffer): Keyer {
  return (identity) => createHmac('sha256', salt).update(identity).digest('hex').slice(0, 12);
}

export const sessionKey = (keyer: Keyer, sessionId: string): string => keyer(`session:${joinId(sessionId)}`);
