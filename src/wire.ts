// Wire protocol v1: one JSON object per line. The collector runs every frame
// through validateFrame before writing it and the TUI runs it again on receipt.
// A frame with an unknown key, or a string outside its pattern or enum, is rejected.
import { isWireAgent } from './agents.ts';

export const PROTOCOL_VERSION = 1;

export const STATES = ['working', 'blocked', 'idle', 'done', 'unknown'] as const;
export type State = (typeof STATES)[number];

export const SOURCES = ['herdr', 'registry', 'proc'] as const;
export type Source = (typeof SOURCES)[number];

export const OS_NAMES = ['linux', 'wsl2', 'darwin', 'unknown'] as const;

export const ERROR_CODES = [
  'ccusage_failed',
  'ccusage_timeout',
  'ccusage_bad_output',
  'herdr_unavailable',
  'proc_unavailable',
  'frame_rejected',
  'salt_unavailable',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface HelloFrame {
  v: 1;
  t: 'hello';
  host: string;
  os: (typeof OS_NAMES)[number];
  collector: string;
  ccusage: string;
}
export interface LiveAgent {
  k: string;
  a: string;
  st: State;
  src: Source;
  seat?: string;
  up?: number;
}
export interface LiveFrame {
  v: 1;
  t: 'live';
  ts: number;
  agents: LiveAgent[];
}
export interface UsageRow {
  k: string;
  a: string;
  m: string[];
  i: number;
  o: number;
  cw: number;
  cr: number;
  /** Absent when ccusage has no price for one of the session's models. */
  c?: number;
  la?: string;
}
export interface UsageFrame {
  v: 1;
  t: 'usage';
  ts: number;
  rows: UsageRow[];
}
export interface TodayFrame {
  v: 1;
  t: 'today';
  ts: number;
  i: number;
  o: number;
  cw: number;
  cr: number;
  c: number;
  unpriced: string[];
}
export interface ErrFrame {
  v: 1;
  t: 'err';
  code: ErrorCode;
}
export type Frame = HelloFrame | LiveFrame | UsageFrame | TodayFrame | ErrFrame;

export const SAFE_STRING = /^[A-Za-z0-9._:-]{1,40}$/;
/** Stands in for any model name outside MODEL_NAME, so the name itself stays home. */
export const OTHER_MODEL = 'other';
/** The closed pattern for model names: known families in lowercase, `default` and OTHER_MODEL. */
export const MODEL_NAME = /^(?:default|other|(?:claude|codex|deepseek|gemini|glm|gpt|grok|kimi|llama|minimax|mistral|qwen)[-0-9][a-z0-9.:-]{0,30}|o[134](?:-[a-z0-9.:-]{1,30})?)$/;
const KEY = /^[0-9a-f]{12}$/;
export const SEAT = /^w[0-9A-Za-z]{1,8}:p[0-9A-Za-z]{1,8}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

type Check = (value: unknown) => boolean;

const pattern = (re: RegExp): Check => (v) => typeof v === 'string' && re.test(v);
const oneOf = (list: readonly unknown[]): Check => (v) => list.includes(v);
const count: Check = (v) => Number.isSafeInteger(v) && (v as number) >= 0;
const amount: Check = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const safe = pattern(SAFE_STRING);
const model = pattern(MODEL_NAME);
const modelList: Check = (v) => Array.isArray(v) && v.every(model);

interface Shape {
  required: Record<string, Check>;
  optional?: Record<string, Check>;
}

function fits(value: unknown, shape: Shape): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    // Own keys only: `constructor` must not find Object through the prototype chain.
    const check = Object.hasOwn(shape.required, key)
      ? shape.required[key]
      : shape.optional && Object.hasOwn(shape.optional, key) ? shape.optional[key] : undefined;
    if (!check?.(record[key])) return false;
  }
  return Object.keys(shape.required).every((key) => Object.hasOwn(record, key));
}

const listOf = (shape: Shape): Check => (v) => Array.isArray(v) && v.every((item) => fits(item, shape));

const LIVE_AGENT: Shape = {
  required: { k: pattern(KEY), a: isWireAgent, st: oneOf(STATES), src: oneOf(SOURCES) },
  optional: { seat: pattern(SEAT), up: count },
};

const USAGE_ROW: Shape = {
  required: { k: pattern(KEY), a: isWireAgent, m: modelList, i: count, o: count, cw: count, cr: count },
  optional: { c: amount, la: pattern(TIMESTAMP) },
};

const header = { v: oneOf([PROTOCOL_VERSION]) };

const FRAMES: Record<string, Shape> = {
  hello: {
    required: { ...header, t: oneOf(['hello']), host: safe, os: oneOf(OS_NAMES), collector: safe, ccusage: safe },
  },
  live: {
    required: { ...header, t: oneOf(['live']), ts: count, agents: listOf(LIVE_AGENT) },
  },
  usage: {
    required: { ...header, t: oneOf(['usage']), ts: count, rows: listOf(USAGE_ROW) },
  },
  today: {
    required: { ...header, t: oneOf(['today']), ts: count, i: count, o: count, cw: count, cr: count, c: amount, unpriced: modelList },
  },
  err: {
    required: { ...header, t: oneOf(['err']), code: oneOf(ERROR_CODES) },
  },
};

export function validateFrame(value: unknown): Frame | null {
  const type = (value as { t?: unknown } | null)?.t;
  if (typeof type !== 'string' || !Object.hasOwn(FRAMES, type)) return null;
  return fits(value, FRAMES[type]!) ? (value as Frame) : null;
}

/** Serialises a frame, or returns null when the frame breaks the allowlist. */
export function encodeFrame(frame: Frame): string | null {
  return validateFrame(frame) ? `${JSON.stringify(frame)}\n` : null;
}

export function decodeFrame(line: string): Frame | null {
  try {
    return validateFrame(JSON.parse(line));
  } catch {
    return null;
  }
}
