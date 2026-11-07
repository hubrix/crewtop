// `crewtop collect --stream`: NDJSON frames on stdout until stdin closes.
// Every frame passes the allowlist in encodeFrame on its way out.
import { release } from 'node:os';
import { encodeFrame, PROTOCOL_VERSION } from '../wire.ts';
import type { ErrorCode, Frame, HelloFrame } from '../wire.ts';
import { CcusageRunner, ccusageVersion, collectorVersion, parseDailyReport, parseSessionReport, usageDelaySeconds } from './ccusage.ts';
import { parseHerdrList, runHerdrList } from './herdr.ts';
import { mergeLive, scanProcesses } from './proc.ts';
import { loadSalt, makeKeyer } from './salt.ts';
import type { Keyer } from './salt.ts';

export const LIVE_INTERVAL_MS = 2_000;
export const TODAY_INTERVAL_MS = 60_000;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** WSL shows only in the kernel string under a non-interactive SSH session. */
export function detectOs(platform: string = process.platform, kernel: string = release()): HelloFrame['os'] {
  if (platform === 'linux') return /microsoft/i.test(kernel) ? 'wsl2' : 'linux';
  return platform === 'darwin' ? 'darwin' : 'unknown';
}

export interface CollectorOptions {
  write: (line: string) => void;
  keyer: Keyer;
  ccusageBin?: string;
  ccusageTimeoutMs?: number;
  herdrBin?: string;
  procRoot?: string;
  liveIntervalMs?: number;
  todayIntervalMs?: number;
  /** Overrides the adaptive delay between usage runs. */
  usageDelayMs?: (cpuSeconds: number) => number;
}

export interface Collector {
  stop(): void;
}

export function startCollector(options: CollectorOptions): Collector {
  const { write, keyer, ccusageBin, ccusageTimeoutMs, herdrBin, procRoot } = options;
  const liveIntervalMs = options.liveIntervalMs ?? LIVE_INTERVAL_MS;
  const todayIntervalMs = options.todayIntervalMs ?? TODAY_INTERVAL_MS;
  const usageDelayMs = options.usageDelayMs ?? ((cpu: number) => usageDelaySeconds(cpu) * 1000);
  const runner = new CcusageRunner({
    ...(ccusageBin === undefined ? {} : { bin: ccusageBin }),
    ...(ccusageTimeoutMs === undefined ? {} : { timeoutMs: ccusageTimeoutMs }),
  });

  let stopped = false;
  const timers = new Set<NodeJS.Timeout>();
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) fn();
    }, ms);
    timers.add(timer);
  };

  const fail = (code: ErrorCode) => {
    const line = encodeFrame({ v: PROTOCOL_VERSION, t: 'err', code });
    if (line && !stopped) write(line);
  };
  const emit = (frame: Frame) => {
    if (stopped) return;
    const line = encodeFrame(frame);
    if (line) write(line);
    else fail('frame_rejected');
  };

  emit({
    v: PROTOCOL_VERSION,
    t: 'hello',
    // A constant, so the machine's name stays home. Wire v1 requires the field.
    host: 'unnamed-host',
    os: detectOs(),
    collector: collectorVersion(),
    ccusage: ccusageVersion(),
  });

  const liveLoop = async () => {
    const startedAt = Date.now();
    const raw = await runHerdrList(herdrBin);
    const herdr = raw === null ? null : parseHerdrList(raw, keyer);
    if (herdr === null) fail('herdr_unavailable');
    const scan = scanProcesses(procRoot);
    if (scan === null) fail('proc_unavailable');
    emit({ v: PROTOCOL_VERSION, t: 'live', ts: nowSeconds(), agents: mergeLive(herdr, scan, keyer) });
    later(liveLoop, Math.max(0, liveIntervalMs - (Date.now() - startedAt)));
  };

  const usageLoop = async () => {
    const result = await runner.run(['session']);
    if (result.ok) {
      const rows = parseSessionReport(result.stdout, keyer);
      if (rows) emit({ v: PROTOCOL_VERSION, t: 'usage', ts: nowSeconds(), rows });
      else fail('ccusage_bad_output');
    } else {
      fail(result.code);
    }
    later(usageLoop, usageDelayMs(result.cpuSeconds));
  };

  const todayLoop = async () => {
    const utcDay = new Date().toISOString().slice(0, 10);
    const result = await runner.run(['daily', '--since', utcDay]);
    if (result.ok) {
      const totals = parseDailyReport(result.stdout);
      if (totals) emit({ v: PROTOCOL_VERSION, t: 'today', ts: nowSeconds(), ...totals });
      else fail('ccusage_bad_output');
    } else {
      fail(result.code);
    }
    later(todayLoop, todayIntervalMs);
  };

  void liveLoop();
  void usageLoop();
  void todayLoop();

  return {
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      runner.stop();
    },
  };
}

/** Runs the collector against this process's stdio until the hub goes away. */
export function runCollectStream(): void {
  let collector: Collector | null = null;
  const shutdown = () => {
    collector?.stop();
    process.exit();
  };
  // While the pipe is full whole frames are dropped: the next frame supersedes them.
  let draining = false;
  process.stdout.on('drain', () => {
    draining = false;
  });
  process.stdout.on('error', shutdown);
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.stdin.on('error', shutdown);
  process.stdin.resume();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, shutdown);
  let keyer: Keyer;
  try {
    keyer = makeKeyer(loadSalt());
  } catch {
    process.stdout.write(encodeFrame({ v: PROTOCOL_VERSION, t: 'err', code: 'salt_unavailable' })!);
    process.exitCode = 1;
    process.stdin.destroy();
    return;
  }
  collector = startCollector({
    keyer,
    write: (line) => {
      if (draining) return;
      if (!process.stdout.write(line)) draining = true;
    },
  });
}
