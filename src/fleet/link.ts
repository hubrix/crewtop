// One member's connection: runs its collector, feeds validated frames to its
// HostModel, and reconnects when it goes away. Links share nothing, so one member
// being down or slow cannot delay another's frames. Child stderr is discarded,
// because SSH errors carry hostnames and paths and remote stderr must not reach
// the hub's screen.
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { NEUTRAL_CWD, PACKAGE_ROOT } from '../collect/ccusage.ts';
import type { HostModel, LostReason } from '../tui/model.ts';
import { decodeFrame } from '../wire.ts';
import type { Member } from './config.ts';

/** ssh gives up on a dead link after 2 unanswered 5 s keepalives. */
export const SSH_OPTIONS = [
  '-T',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=8',
  '-o', 'ServerAliveInterval=5',
  '-o', 'ServerAliveCountMax=2',
  // A shared master would outlive this process and survive a kill of this client.
  '-o', 'ControlPath=none',
  '-o', 'ClearAllForwardings=yes',
  '-o', 'ForwardAgent=no',
  '-o', 'ForwardX11=no',
  '-o', 'LogLevel=ERROR',
];
const REMOTE_COMMAND = ['crewtop', 'collect', '--stream'];

export const RETRY_MIN_MS = 3_000;
export const RETRY_MAX_MS = 30_000;
/** No line at all for this long means the collector is frozen, even if ssh's keepalives still pass. */
export const WATCHDOG_MS = 20_000;
/** Far above any real frame: a 500 KB usage frame was measured for 3,392 sessions. */
export const MAX_LINE_CHARS = 16 * 1024 * 1024;

export interface LinkOptions {
  sshBin?: string;
  retryMinMs?: number;
  retryMaxMs?: number;
  watchdogMs?: number;
  maxLineChars?: number;
}

export function collectorCommand(member: Member, sshBin = 'ssh'): { file: string; args: string[]; cwd?: string } {
  // The local collector must not inherit the directory the dashboard was launched from.
  if (member.ssh === null) return { file: process.execPath, args: [join(PACKAGE_ROOT, 'bin', 'crewtop'), 'collect', '--stream'], cwd: NEUTRAL_CWD };
  return { file: sshBin, args: [...SSH_OPTIONS, '--', member.ssh, ...REMOTE_COMMAND] };
}

/** Exit codes only: 255 is ssh's own failure, 126 and 127 are the remote shell's "cannot run that". */
export function lostReason(isRemote: boolean, code: number | null): LostReason {
  if (!isRemote) return 'exited';
  if (code === 126 || code === 127) return 'no-crewtop';
  return code === 255 || code === null || code < 0 ? 'no-link' : 'exited';
}

export class MemberLink {
  private readonly member: Member;
  private readonly model: HostModel;
  private readonly sshBin: string | undefined;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private readonly watchdogMs: number;
  private readonly maxLineChars: number;
  private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private failures = 0;
  private stopped = false;

  constructor(member: Member, model: HostModel, options: LinkOptions = {}) {
    this.member = member;
    this.model = model;
    this.sshBin = options.sshBin;
    this.retryMinMs = options.retryMinMs ?? RETRY_MIN_MS;
    this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
    this.watchdogMs = options.watchdogMs ?? WATCHDOG_MS;
    this.maxLineChars = options.maxLineChars ?? MAX_LINE_CHARS;
  }

  start(): void {
    this.connect();
  }

  /** Closing stdin is what ends the collector; the signal also ends a local ssh that is still connecting. */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.watchdog) clearTimeout(this.watchdog);
    this.child?.stdin.end();
    this.child?.kill('SIGTERM');
  }

  /** The child's pid while connected. */
  pid(): number | null {
    return this.child?.pid ?? null;
  }

  private connect(): void {
    this.retryTimer = null;
    const { file, args, cwd } = collectorCommand(this.member, this.sshBin);
    let child: ChildProcessByStdio<Writable, Readable, null>;
    try {
      child = spawn(file, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
      child.on('error', () => {});
      child.stdin.on('error', () => {});
    } catch {
      this.lost(null);
      return;
    }
    this.child = child;
    let opened = false;
    let partial = '';

    const forceClose = () => {
      child.kill('SIGKILL');
      // 'close' waits for stdio, and a grandchild could hold it open forever.
      child.stdin.destroy();
      child.stdout.destroy();
    };
    const armWatchdog = () => {
      if (this.watchdog) clearTimeout(this.watchdog);
      this.watchdog = setTimeout(forceClose, this.watchdogMs);
    };
    const onLine = (line: string) => {
      if (!opened) {
        opened = true;
        this.model.connectionOpened(Date.now());
      }
      const frame = decodeFrame(line);
      if (!frame) {
        this.model.frameRejected();
        return;
      }
      if (frame.t === 'live') this.failures = 0;
      this.model.apply(frame, Date.now());
    };

    armWatchdog();
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (this.stopped) return;
      armWatchdog();
      const lines = (partial + chunk).split('\n');
      partial = lines.pop()!;
      for (const line of lines) onLine(line);
      if (partial.length > this.maxLineChars) forceClose();
    });
    child.stdout.on('error', () => {});
    child.on('close', (code) => {
      this.child = null;
      if (this.watchdog) clearTimeout(this.watchdog);
      if (!this.stopped) this.lost(code);
    });
  }

  private lost(code: number | null): void {
    this.model.connectionLost(Date.now(), lostReason(this.member.ssh !== null, code));
    const delay = Math.min(this.retryMaxMs, this.retryMinMs * 2 ** this.failures);
    this.failures++;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
}
