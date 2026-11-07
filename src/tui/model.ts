// What the TUI knows, built only from validated frames. It keeps the honesty
// rules in one place: null is "no sample yet" and 'n/a' is "unsupported or
// unpriced". Neither is ever turned into 0.
import { hostname } from 'node:os';
import { isCoveredByCcusage } from '../agents.ts';
import { SAFE_STRING } from '../wire.ts';
import type { ErrorCode, Frame, HelloFrame, LiveAgent, State, TodayFrame, UsageRow } from '../wire.ts';

export const BURN_WINDOW_SECONDS = 300;
/** Three missed 2 s `live` frames, plus a second of scheduling slack. */
export const STALE_AFTER_MS = 7_000;
/** How long a lost member's last values stay on screen, greyed, before they are hidden. */
export const LOST_HOLD_MS = 300_000;
const ERROR_TTL_MS = 10_000;
const CCUSAGE_ERRORS: readonly ErrorCode[] = ['ccusage_failed', 'ccusage_timeout', 'ccusage_bad_output'];

export type Metric = number | null | 'n/a';
export type HostStatus = 'waiting' | 'live' | 'stale' | 'unreachable' | 'update-needed';
/** A closed list, never remote text. See lostReason in src/fleet/link.ts. */
export type LostReason = 'no-link' | 'no-crewtop' | 'exited';

interface Sample {
  t: number;
  fresh: number;
  cache: number;
  cost: number | null;
}

interface UsageEntry {
  row: UsageRow;
  samples: Sample[];
}

export interface Row {
  id: string;
  host: string;
  seat: string | null;
  agent: string;
  state: State;
  /** False for a usage row with no live agent: ended, or outside Herdr and the process net. */
  live: boolean;
  /** True when these are the last values from a member that has stopped responding. */
  held: boolean;
  model: string | null;
  tokensPerMinute: Metric;
  costPerHour: Metric;
  tokens: Metric;
  cost: Metric;
  lastSeconds: number | null;
  upSeconds: number | null;
  usage: UsageRow | null;
}

export interface Burn {
  tokensPerMinute: number | null;
  costPerHour: number | null;
}

function wireKey(agent: string, k: string): string {
  return `${agent}|${k}`;
}

function shortModel(models: string[]): string | null {
  const model = models[0];
  return model ? model.replace(/^claude-/, '') : null;
}

function burnOf(samples: Sample[], withCache: boolean): { tokensPerMinute: number | null; costPerHour: Metric } {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last || last.t <= first.t) return { tokensPerMinute: null, costPerHour: null };
  const seconds = last.t - first.t;
  const tokens = (s: Sample) => s.fresh + (withCache ? s.cache : 0);
  return {
    tokensPerMinute: ((tokens(last) - tokens(first)) / seconds) * 60,
    costPerHour: first.cost === null || last.cost === null ? 'n/a' : ((last.cost - first.cost) / seconds) * 3600,
  };
}

/** The name for the local view with no config. It is read here and never comes off the wire. */
function localName(): string {
  const name = hostname();
  return SAFE_STRING.test(name) ? name : 'local';
}

export class HostModel {
  hello: HelloFrame | null = null;
  today: TodayFrame | null = null;
  rejected = 0;
  private live: LiveAgent[] = [];
  private liveAt: number | null = null;
  private usage = new Map<string, UsageEntry>();
  private errors = new Map<ErrorCode, number>();
  private connected = false;
  private lostAt: number | null = null;
  private lostWhy: LostReason | null = null;
  private validSinceOpen = false;
  private rejectedSinceOpen = 0;
  private readonly name: string;

  /** `name` is the member's configured display name. Without one this is the local view of this machine. */
  constructor(name: string | null = null) {
    this.name = name ?? localName();
  }

  /**
   * A new collector has started talking. Burn samples from before this point are
   * discarded, so the catch-up cannot draw a spike. Last values stay until the new
   * collector's frames replace them, unless they were already hidden.
   */
  connectionOpened(nowMs: number): void {
    if (this.status(nowMs) === 'unreachable') {
      this.today = null;
      this.live = [];
      this.liveAt = null;
      this.usage = new Map();
    }
    for (const entry of this.usage.values()) entry.samples = [];
    this.errors = new Map();
    this.connected = true;
    this.lostAt = null;
    this.lostWhy = null;
    this.validSinceOpen = false;
    this.rejectedSinceOpen = 0;
  }

  /** A failed reconnect keeps the first loss time, so the hold is not extended. */
  connectionLost(nowMs: number, reason: LostReason = 'exited'): void {
    this.connected = false;
    this.lostAt ??= nowMs;
    this.lostWhy = reason;
  }

  frameRejected(): void {
    this.rejected++;
    this.rejectedSinceOpen++;
  }

  lostReason(): LostReason | null {
    return this.lostWhy;
  }

  apply(frame: Frame, nowMs: number): void {
    this.validSinceOpen = true;
    switch (frame.t) {
      case 'hello':
        this.hello = frame;
        break;
      case 'live':
        this.live = frame.agents;
        this.liveAt = nowMs;
        break;
      case 'usage':
        this.applyUsage(frame.ts, frame.rows);
        for (const code of CCUSAGE_ERRORS) this.errors.delete(code);
        break;
      case 'today':
        this.today = frame;
        break;
      case 'err':
        this.errors.set(frame.code, nowMs);
        break;
    }
  }

  private applyUsage(ts: number, rows: UsageRow[]): void {
    const next = new Map<string, UsageEntry>();
    for (const row of rows) {
      const key = wireKey(row.a, row.k);
      const sample: Sample = { t: ts, fresh: row.i + row.o, cache: row.cw + row.cr, cost: row.c ?? null };
      const previous = this.usage.get(key)?.samples ?? [];
      const latest = previous[previous.length - 1];
      // A counter that went down means the source was rewritten: start over.
      const decreased = latest && (sample.fresh < latest.fresh || sample.cache < latest.cache || (sample.cost ?? 0) < (latest.cost ?? 0));
      const samples = decreased ? [sample] : [...previous.filter((s) => s.t >= ts - BURN_WINDOW_SECONDS), sample];
      next.set(key, { row, samples });
    }
    this.usage = next;
  }

  host(): string {
    return this.name;
  }

  status(nowMs: number): HostStatus {
    // Talking, but in frames this build rejects: most likely a different protocol version.
    if (this.connected && !this.validSinceOpen && this.rejectedSinceOpen > 0) return 'update-needed';
    if (this.liveAt === null) return this.lostAt === null ? 'waiting' : 'unreachable';
    if (this.lostAt !== null && nowMs - this.lostAt > LOST_HOLD_MS) return 'unreachable';
    return this.lostAt !== null || nowMs - this.liveAt > STALE_AFTER_MS ? 'stale' : 'live';
  }

  /** Today's totals while they are on screen, held or fresh. */
  todayShown(nowMs: number): TodayFrame | null {
    const status = this.status(nowMs);
    return status === 'live' || status === 'stale' ? this.today : null;
  }

  liveAgeSeconds(nowMs: number): number | null {
    return this.liveAt === null ? null : Math.floor((nowMs - this.liveAt) / 1000);
  }

  activeErrors(nowMs: number): ErrorCode[] {
    const active: ErrorCode[] = [];
    for (const [code, at] of this.errors) {
      if (CCUSAGE_ERRORS.includes(code) || nowMs - at <= ERROR_TTL_MS) active.push(code);
    }
    return active;
  }

  /** Every row, in no particular order. Past the hold, or on a version mismatch, no numbers show. */
  rows(nowMs: number, withCache: boolean): Row[] {
    const status = this.status(nowMs);
    if (status === 'unreachable' || status === 'update-needed') return [];
    const held = status === 'stale';
    return this.buildRows(nowMs, withCache).map((row) => ({ ...row, held }));
  }

  private buildRows(nowMs: number, withCache: boolean): Row[] {
    const rows: Row[] = [];
    const joined = new Set<string>();
    for (const agent of this.live) {
      const key = wireKey(agent.a, agent.k);
      const entry = this.usage.get(key);
      if (entry) joined.add(key);
      rows.push(this.toRow(`live:${key}`, agent, entry, nowMs, withCache));
    }
    for (const [key, entry] of this.usage) {
      if (joined.has(key)) continue;
      const orphan: LiveAgent = { k: entry.row.k, a: entry.row.a, st: 'unknown', src: 'proc' };
      rows.push({ ...this.toRow(`usage:${key}`, orphan, entry, nowMs, withCache), live: false });
    }
    return rows;
  }

  private toRow(id: string, agent: LiveAgent, entry: UsageEntry | undefined, nowMs: number, withCache: boolean): Row {
    const base = {
      // A wire key is only meaningful within its member, so the id needs the member too.
      id: `${this.host()}|${id}`,
      host: this.host(),
      seat: agent.seat ?? null,
      agent: agent.a,
      state: agent.st,
      live: true,
      held: false,
      upSeconds: agent.up ?? null,
    };
    if (!entry) {
      const unsupported = !isCoveredByCcusage(agent.a);
      const missing: Metric = unsupported ? 'n/a' : null;
      return { ...base, model: null, tokensPerMinute: missing, costPerHour: missing, tokens: missing, cost: missing, lastSeconds: null, usage: null };
    }
    const { row, samples } = entry;
    const burn = burnOf(samples, withCache);
    const lastActivity = row.la === undefined ? null : Date.parse(row.la);
    return {
      ...base,
      model: shortModel(row.m),
      tokensPerMinute: burn.tokensPerMinute,
      costPerHour: row.c === undefined ? 'n/a' : burn.costPerHour,
      tokens: row.i + row.o + row.cw + row.cr,
      cost: row.c ?? 'n/a',
      lastSeconds: lastActivity === null ? null : Math.max(0, Math.floor((nowMs - lastActivity) / 1000)),
      usage: row,
    };
  }

  /** Sums burn over every session, shown or hidden. Null until any session has two samples. */
  burn(withCache: boolean): Burn {
    let tokensPerMinute: number | null = null;
    let costPerHour: number | null = null;
    for (const { samples } of this.usage.values()) {
      const burn = burnOf(samples, withCache);
      if (burn.tokensPerMinute !== null) tokensPerMinute = (tokensPerMinute ?? 0) + burn.tokensPerMinute;
      if (typeof burn.costPerHour === 'number') costPerHour = (costPerHour ?? 0) + burn.costPerHour;
    }
    return { tokensPerMinute, costPerHour };
  }
}

export const SORT_MODES = ['$/h', 'tok/m', 'tokens', 'cost', 'last', 'state', 'agent'] as const;
export type SortMode = (typeof SORT_MODES)[number];

const STATE_ORDER: Record<State, number> = { working: 0, blocked: 1, idle: 2, done: 3, unknown: 4 };

/** Running agents, then other live agents, then usage rows with no live agent. Held rows sink below all of those. */
function rank(row: Row): number {
  const base = !row.live ? 2 : row.state === 'working' || row.state === 'blocked' ? 0 : 1;
  return row.held ? base + 3 : base;
}

const numeric = (metric: Metric | number | null): number => (typeof metric === 'number' ? metric : -1);

function sortValue(row: Row, mode: SortMode): number {
  switch (mode) {
    case '$/h':
      return numeric(row.costPerHour);
    case 'tok/m':
      return numeric(row.tokensPerMinute);
    case 'tokens':
      return numeric(row.tokens);
    case 'cost':
      return numeric(row.cost);
    case 'last':
      return row.lastSeconds === null ? -Infinity : -row.lastSeconds;
    case 'state':
      return -STATE_ORDER[row.state];
    case 'agent':
      return 0;
  }
}

export function sortRows(rows: Row[], mode: SortMode): Row[] {
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      sortValue(b, mode) - sortValue(a, mode) ||
      a.agent.localeCompare(b.agent) ||
      a.id.localeCompare(b.id),
  );
}

export function matchesText(row: Row, text: string): boolean {
  const needle = text.toLowerCase();
  return [row.host, row.agent, row.state, row.seat ?? '', row.model ?? ''].some((field) => field.toLowerCase().includes(needle));
}
