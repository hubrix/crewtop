// Process-table safety net: finds agents Herdr does not show. argv can hold a
// prompt, so only the first two arguments are read, only their basenames are
// compared, and the sole output is a name from the closed list.
import { closeSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { basename, join } from 'node:path';
import { closedAgentName } from '../agents.ts';
import type { LiveAgent } from '../wire.ts';
import type { Keyer } from './salt.ts';

const CLOCK_TICKS_PER_SECOND = 100;
const ARGV_READ_BYTES = 4096;
const MAX_ANCESTORS = 256;

/** Hosts that run an agent script, so argv[1] names the program. */
const INTERPRETERS: ReadonlySet<string> = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'sh', 'bash', 'dash']);

const SCRIPT_EXTENSION = /\.(?:[cm]?js|ts|py|sh)$/;

function firstTwoArgs(path: string): [string, string] {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(ARGV_READ_BYTES);
    const read = readSync(fd, buffer, 0, ARGV_READ_BYTES, 0);
    const [first = '', second = ''] = buffer.toString('latin1', 0, read).split('\0', 2);
    return [first, second];
  } finally {
    closeSync(fd);
  }
}

/** Returns the closed-list name a process runs as, or null. */
export function matchProcessName(comm: string, argv0: string, argv1: string): string | null {
  if (argv0 === '') return null; // Kernel thread.
  const program = basename(argv0);
  const direct = closedAgentName(program);
  if (direct) return direct;
  if (INTERPRETERS.has(program)) {
    const script = closedAgentName(basename(argv1).replace(SCRIPT_EXTENSION, ''));
    if (script) return script;
  }
  return closedAgentName(comm);
}

export interface ProcEntry {
  pid: number;
  ppid: number;
  startTicks: number;
  /** Closed-list agent name, or null when this process is not an agent. */
  agent: string | null;
  isHerdr: boolean;
}

export interface ProcAgent {
  pid: number;
  agent: string;
  startTicks: number;
  underHerdr: boolean;
}

export interface ProcScan {
  /** Agent processes, leaving out helpers an agent of the same name spawned. */
  agents: ProcAgent[];
  uptimeSeconds: number;
}

/** Walks the process table, or returns null when it cannot be read. */
export function scanProcesses(root = '/proc'): ProcScan | null {
  let names: string[];
  let uptimeSeconds: number;
  try {
    names = readdirSync(root);
    uptimeSeconds = Number(readFileSync(join(root, 'uptime'), 'latin1').split(' ')[0]);
  } catch {
    return null;
  }
  const entries = new Map<number, ProcEntry>();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(join(root, name, 'stat'), 'latin1');
      const open = stat.indexOf('(');
      const close = stat.lastIndexOf(')');
      const comm = stat.slice(open + 1, close);
      const fields = stat.slice(close + 2).split(' ');
      const [argv0, argv1] = firstTwoArgs(join(root, name, 'cmdline'));
      const pid = Number(name);
      entries.set(pid, {
        pid,
        ppid: Number(fields[1]),
        startTicks: Number(fields[19]),
        agent: matchProcessName(comm, argv0, argv1),
        isHerdr: basename(argv0) === 'herdr',
      });
    } catch {
      // The process exited mid-scan or belongs to another user.
    }
  }
  const agents: ProcAgent[] = [];
  for (const entry of entries.values()) {
    if (!entry.agent) continue;
    let nested = false;
    let underHerdr = false;
    let parent = entries.get(entry.ppid);
    for (let depth = 0; parent && depth < MAX_ANCESTORS; depth++) {
      if (parent.agent === entry.agent) nested = true;
      if (parent.isHerdr) underHerdr = true;
      parent = entries.get(parent.ppid);
    }
    if (!nested) agents.push({ pid: entry.pid, agent: entry.agent, startTicks: entry.startTicks, underHerdr });
  }
  return { agents, uptimeSeconds };
}

function uptimeOf(proc: ProcAgent, uptimeSeconds: number): number {
  return Math.max(0, Math.floor(uptimeSeconds - proc.startTicks / CLOCK_TICKS_PER_SECOND));
}

/**
 * Merges Herdr rows with the process scan. Herdr's list has no pid, so the two
 * join by count per agent name: processes beyond Herdr's count become `proc` rows,
 * taking those outside any Herdr pane first. A Herdr row gets an uptime only when
 * it pairs with exactly one process, because otherwise the pairing is a guess.
 */
export function mergeLive(herdr: LiveAgent[] | null, scan: ProcScan | null, keyer: Keyer): LiveAgent[] {
  const rows = (herdr ?? []).map((row) => ({ ...row }));
  if (!scan) return rows;
  const byAgent = new Map<string, ProcAgent[]>();
  for (const proc of scan.agents) {
    byAgent.set(proc.agent, [...(byAgent.get(proc.agent) ?? []), proc]);
  }
  for (const [agent, procs] of byAgent) {
    const herdrRows = rows.filter((row) => row.src === 'herdr' && row.a === agent);
    const onlyPair = herdrRows.length === 1 && procs.length === 1 ? procs[0] : undefined;
    if (onlyPair) herdrRows[0]!.up = uptimeOf(onlyPair, scan.uptimeSeconds);
    const ordered = [...procs].sort((a, b) => Number(a.underHerdr) - Number(b.underHerdr) || b.startTicks - a.startTicks);
    for (const proc of ordered.slice(0, Math.max(0, procs.length - herdrRows.length))) {
      rows.push({
        k: keyer(`proc:${proc.pid}:${proc.startTicks}`),
        a: agent,
        st: 'unknown',
        src: 'proc',
        up: uptimeOf(proc, scan.uptimeSeconds),
      });
    }
  }
  return rows;
}
