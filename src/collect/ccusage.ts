// The only reader of usage logs is the pinned ccusage. crewtop never opens a
// transcript. The output is parsed field by field, so nothing unnamed survives.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closedAgentName, OTHER_AGENT } from '../agents.ts';
import { MODEL_NAME, OTHER_MODEL } from '../wire.ts';
import type { ErrorCode, UsageRow } from '../wire.ts';
import { sessionKey } from './salt.ts';
import type { Keyer } from './salt.ts';

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CCUSAGE_BIN = join(PACKAGE_ROOT, 'node_modules', '.bin', 'ccusage');
export const CCUSAGE_TIMEOUT_MS = 30_000;
/** Passed as --config, so no ccusage.json from the launch directory or home is read. */
export const CCUSAGE_CONFIG = join(PACKAGE_ROOT, 'src', 'collect', 'ccusage-empty-config.json');
/** A directory no attacker controls, for a process that reads config from its cwd. */
export const NEUTRAL_CWD = '/';
/** All that ccusage gets from the environment. test/contract.test.ts checks it against the binary. */
export const CCUSAGE_ENV_VARS = [
  'PATH',
  'HOME',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'AMP_DATA_DIR',
  'ANTIGRAVITY_DATA_DIR',
  'CLAUDE_CONFIG_DIR',
  'CODEBUFF_DATA_DIR',
  'CODEX_HOME',
  'COPILOT_HOME',
  'DROID_SESSIONS_DIR',
  'GEMINI_DATA_DIR',
  'GOOSE_PATH_ROOT',
  'GROK_HOME',
  'HERMES_HOME',
  'KILO_DATA_DIR',
  'KIMI_DATA_DIR',
  'OPENCLAW_DIR',
  'OPENCODE_DATA_DIR',
  'PI_AGENT_DIR',
  'QWEN_DATA_DIR',
  'ZCODE_HOME',
] as const;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

function packageVersion(path: string): string {
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

export const collectorVersion = () => packageVersion(join(PACKAGE_ROOT, 'package.json'));
export const ccusageVersion = () => packageVersion(join(PACKAGE_ROOT, 'node_modules', 'ccusage', 'package.json'));

export type RunResult =
  | { ok: true; stdout: string; cpuSeconds: number }
  | { ok: false; code: ErrorCode; cpuSeconds: number };

/** CPU seconds used by this process's reaped children. Linux only; else null. */
function reapedChildCpuSeconds(): number | null {
  try {
    const stat = readFileSync('/proc/self/stat', 'latin1');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return (Number(fields[13]) + Number(fields[14])) / 100;
  } catch {
    return null;
  }
}

export interface CcusageRunnerOptions {
  bin?: string;
  timeoutMs?: number;
  /** The environment to pick CCUSAGE_ENV_VARS from. */
  env?: NodeJS.ProcessEnv;
}

function allowedEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of CCUSAGE_ENV_VARS) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

/** Runs ccusage one child at a time: a second call waits for the first to end. */
export class CcusageRunner {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private tail: Promise<unknown> = Promise.resolve();
  private killCurrent: (() => void) | null = null;
  private stopped = false;

  constructor({ bin = CCUSAGE_BIN, timeoutMs = CCUSAGE_TIMEOUT_MS, env = process.env }: CcusageRunnerOptions = {}) {
    this.bin = bin;
    this.timeoutMs = timeoutMs;
    this.env = allowedEnv(env);
  }

  run(report: string[]): Promise<RunResult> {
    const result = this.tail.then(() => this.runOne(report));
    this.tail = result;
    return result;
  }

  stop(): void {
    this.stopped = true;
    this.killCurrent?.();
  }

  private runOne(report: string[]): Promise<RunResult> {
    if (this.stopped) return Promise.resolve({ ok: false, code: 'ccusage_failed', cpuSeconds: 0 });
    const startedAt = Date.now();
    const cpuBefore = reapedChildCpuSeconds();
    return new Promise((resolve) => {
      const child = spawn('nice', ['-n', '10', this.bin, ...report, '--json', '--offline', '--timezone', 'UTC', '--config', CCUSAGE_CONFIG], {
        // stderr can echo configured paths, so it is never opened.
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd: NEUTRAL_CWD,
        env: { ...this.env, CCUSAGE_OFFLINE: '1' },
        // The npm launcher forwards to a native child; a process group ends both.
        detached: true,
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: ErrorCode | null = null;
      const kill = (code: ErrorCode) => {
        failure ??= code;
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The group has already gone.
        }
      };
      this.killCurrent = () => kill('ccusage_failed');
      const timer = setTimeout(() => kill('ccusage_timeout'), this.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) kill('ccusage_failed');
        else chunks.push(chunk);
      });
      const finish = (status: number | null) => {
        clearTimeout(timer);
        this.killCurrent = null;
        const cpuAfter = reapedChildCpuSeconds();
        const cpuSeconds = cpuBefore !== null && cpuAfter !== null ? cpuAfter - cpuBefore : (Date.now() - startedAt) / 1000;
        if (failure || status !== 0) resolve({ ok: false, code: failure ?? 'ccusage_failed', cpuSeconds });
        else resolve({ ok: true, stdout: Buffer.concat(chunks).toString('utf8'), cpuSeconds });
      };
      child.on('error', () => {
        failure ??= 'ccusage_failed';
        finish(null);
      });
      child.on('close', finish);
    });
  }
}

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Strips ccusage's "[pi] " prefix; any name outside the closed pattern becomes OTHER_MODEL. */
function wireModel(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/^\[[a-z-]+\] /, '') : '';
  return MODEL_NAME.test(name) ? name : OTHER_MODEL;
}

function wireTimestamp(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Returns usage rows, or null when the JSON does not match the contract. */
export function parseSessionReport(text: string, keyer: Keyer): UsageRow[] | null {
  let report: { session?: unknown };
  try {
    report = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(report?.session)) return null;
  const rows: UsageRow[] = [];
  for (const raw of report.session as Record<string, unknown>[]) {
    const { period, agent, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalCost } = raw ?? {};
    if (typeof period !== 'string' || period === '') return null;
    if (!isCount(inputTokens) || !isCount(outputTokens) || !isCount(cacheCreationTokens) || !isCount(cacheReadTokens)) return null;
    if (!isAmount(totalCost)) return null;
    const row: UsageRow = {
      k: sessionKey(keyer, period),
      a: closedAgentName(agent) ?? OTHER_AGENT,
      m: Array.isArray(raw.modelsUsed) ? raw.modelsUsed.map(wireModel) : [],
      i: inputTokens,
      o: outputTokens,
      cw: cacheCreationTokens,
      cr: cacheReadTokens,
    };
    const breakdowns = Array.isArray(raw.modelBreakdowns) ? (raw.modelBreakdowns as { missingPricing?: unknown }[]) : [];
    if (!breakdowns.some((b) => b?.missingPricing === true)) row.c = totalCost;
    const lastActivity = wireTimestamp((raw.metadata as { lastActivity?: unknown } | undefined)?.lastActivity);
    if (lastActivity) row.la = lastActivity;
    rows.push(row);
  }
  return rows;
}

export interface TodayTotals {
  i: number;
  o: number;
  cw: number;
  cr: number;
  c: number;
  unpriced: string[];
}

/** Reads a daily report's totals, or returns null when they break the contract. */
export function parseDailyReport(text: string): TodayTotals | null {
  let report: { totals?: Record<string, unknown> };
  try {
    report = JSON.parse(text);
  } catch {
    return null;
  }
  const { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalCost, unpricedModels } = report?.totals ?? {};
  if (!isCount(inputTokens) || !isCount(outputTokens) || !isCount(cacheCreationTokens) || !isCount(cacheReadTokens)) return null;
  if (!isAmount(totalCost)) return null;
  const unpriced = Array.isArray(unpricedModels) ? unpricedModels.map(wireModel) : [];
  return { i: inputTokens, o: outputTokens, cw: cacheCreationTokens, cr: cacheReadTokens, c: totalCost, unpriced };
}

/** Seconds to the next usage run: holds ccusage near 10% of a core, within 15-120 s. */
export function usageDelaySeconds(lastRunCpuSeconds: number): number {
  return Math.min(120, Math.max(15, 10 * lastRunCpuSeconds));
}
