// Turns the model into screen lines. Pure: no terminal, no clock, no I/O.
// All text comes from validated frames or from literals here, so it is ASCII
// plus the single-width separator, and clipping can count characters.
import type { Burn, HostModel, LostReason, Metric, Row } from './model.ts';
import { OTHER_MODEL } from '../wire.ts';
import type { State } from '../wire.ts';
import { selectedIndex, settle, visibleRows } from './view.ts';
import type { View } from './view.ts';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const REVERSE = '\x1b[7m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';

const STATE_COLOR: Record<State, string> = { working: GREEN, blocked: RED, idle: CYAN, done: BLUE, unknown: DIM };
const METER_WIDTH = 24;

export function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}G`;
}

export function formatCost(value: number): string {
  return value >= 1_000 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
}

export function formatRate(value: number): string {
  return value < 10 && value > 0 ? `$${value.toFixed(2)}` : `$${Math.round(value)}`;
}

export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function metric(value: Metric, format: (n: number) => string): string {
  if (value === null) return '-';
  return value === 'n/a' ? 'n/a' : format(value);
}

/** Cuts a line to `width` visible characters, keeping its colour sequences. */
export function clip(line: string, width: number): string {
  let visible = 0;
  let out = '';
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) {
      out += part;
    } else {
      const room = width - visible;
      out += part.slice(0, Math.max(0, room));
      visible += part.length;
    }
  }
  return out + RESET;
}

const left = (text: string, width: number) => text.slice(0, width).padEnd(width);
const right = (text: string, width: number) => text.slice(0, width).padStart(width);

interface ColumnCells {
  host: string;
  seat: string;
  agent: string;
  state: string;
  stateColor: string;
  model: string;
  tokensPerMinute: string;
  costPerHour: string;
  tokens: string;
  cost: string;
  last: string;
  up: string;
}

type ColumnId = Exclude<keyof ColumnCells, 'stateColor'>;

const ALL_COLUMNS: readonly ColumnId[] = ['host', 'seat', 'agent', 'state', 'model', 'tokensPerMinute', 'costPerHour', 'tokens', 'cost', 'last', 'up'];
const MEDIUM_COLUMNS = ALL_COLUMNS.filter((id) => id !== 'model' && id !== 'up');
const NARROW_COLUMNS = MEDIUM_COLUMNS.filter((id) => id !== 'tokens');
const PHONE_COLUMNS: readonly ColumnId[] = ['host', 'agent', 'state', 'costPerHour'];
const PHONE_WIDTH = 60;
const BAR_MIN_WIDTH = 80;
const MAX_HOST_WIDTH = 20;

const COLUMN_WIDTHS: Record<Exclude<ColumnId, 'host'>, number> = {
  seat: 6,
  agent: 11,
  state: 8,
  model: 11,
  tokensPerMinute: 7,
  costPerHour: 6,
  tokens: 8,
  cost: 8,
  last: 5,
  up: 4,
};

function columnsFor(width: number): readonly ColumnId[] {
  if (width < PHONE_WIDTH) return PHONE_COLUMNS;
  if (width < BAR_MIN_WIDTH) return NARROW_COLUMNS;
  return width < 100 ? MEDIUM_COLUMNS : ALL_COLUMNS;
}

function layout(cells: ColumnCells, columns: readonly ColumnId[], hostWidth: number, color: boolean): string {
  return columns
    .map((id) => {
      if (id === 'host') return left(cells.host, hostWidth);
      const width = COLUMN_WIDTHS[id];
      if (id === 'state') return color ? `${cells.stateColor}${left(cells.state, width)}${RESET}` : left(cells.state, width);
      return id === 'seat' || id === 'agent' || id === 'model' ? left(cells[id], width) : right(cells[id], width);
    })
    .join(' ');
}

/**
 * Short host labels for a phone-width table, whose meter lines carry the full
 * names: word initials, so box-a and box read as ba and b. A collision
 * falls back to the member's position.
 */
export function hostAbbreviations(names: string[]): Map<string, string> {
  const initials = names.map((name) => name.split(/[-_.:]/).map((word) => word.slice(0, 1)).join('').toLowerCase());
  return new Map(names.map((name, index) => {
    const initial = initials[index]!;
    return [name, initials.indexOf(initial) === initials.lastIndexOf(initial) ? initial : `${initial.slice(0, 1)}${index + 1}`];
  }));
}

function rowCells(row: Row, hostLabel: string): ColumnCells {
  return {
    host: hostLabel,
    seat: row.seat ?? '-',
    agent: row.agent,
    state: row.state,
    stateColor: STATE_COLOR[row.state],
    model: row.model ?? '-',
    tokensPerMinute: metric(row.tokensPerMinute, formatTokens),
    costPerHour: metric(row.costPerHour, formatRate),
    tokens: metric(row.tokens, formatTokens),
    cost: metric(row.cost, formatCost),
    last: row.lastSeconds === null ? '-' : formatAge(row.lastSeconds),
    up: row.upSeconds === null ? '-' : formatAge(row.upSeconds),
  };
}

const COLUMN_TITLES: ColumnCells = {
  host: 'HOST',
  seat: 'SEAT',
  agent: 'AGENT',
  state: 'STATE',
  stateColor: '',
  model: 'MODEL',
  tokensPerMinute: 'TOK/M',
  costPerHour: '$/H',
  tokens: 'TOKENS',
  cost: 'COST',
  last: 'LAST',
  up: 'UP',
};

/** Burn and agent counts cover live members only: a held value says nothing about now. */
function fleetBurn(hosts: HostModel[], withCache: boolean, nowMs: number): Burn {
  let tokensPerMinute: number | null = null;
  let costPerHour: number | null = null;
  for (const host of hosts) {
    if (host.status(nowMs) !== 'live') continue;
    const burn = host.burn(withCache);
    if (burn.tokensPerMinute !== null) tokensPerMinute = (tokensPerMinute ?? 0) + burn.tokensPerMinute;
    if (burn.costPerHour !== null) costPerHour = (costPerHour ?? 0) + burn.costPerHour;
  }
  return { tokensPerMinute, costPerHour };
}

function headerLine(hosts: HostModel[], view: View, width: number, nowMs: number, clock: string): string {
  const liveHosts = hosts.filter((host) => host.status(nowMs) === 'live');
  const live = liveHosts.flatMap((host) => host.rows(nowMs, view.withCache)).filter((row) => row.live);
  const states: State[] = ['working', 'blocked', 'idle', 'done', 'unknown'];
  const counts = states
    .map((state) => [live.filter((row) => row.state === state).length, state] as const)
    .filter(([n]) => n > 0)
    .map(([n, state]) => `${n} ${state}`)
    .join(' ');
  const noun = live.length === 1 ? 'agent' : 'agents';
  const agentTotal = liveHosts.length === 0 ? 'agents -' : `${live.length} ${noun}`;
  const agents = counts ? `${agentTotal}: ${counts}` : agentTotal;

  const todays = hosts.flatMap((host) => host.todayShown(nowMs) ?? []);
  const tokens = todays.reduce((sum, t) => sum + t.i + t.o + t.cw + t.cr, 0);
  const cost = todays.reduce((sum, t) => sum + t.c, 0);
  // Each OTHER_MODEL stands for a different withheld name, so those count one by one.
  const unpricedNames = todays.flatMap((t) => t.unpriced);
  const unpriced = new Set(unpricedNames.filter((name) => name !== OTHER_MODEL)).size + unpricedNames.filter((name) => name === OTHER_MODEL).length;
  const partial = todays.length > 0 && todays.length < hosts.length ? ` (${todays.length}/${hosts.length} machines)` : '';
  const todayCost = todays.length > 0 ? formatCost(cost) : '-';
  const todayText = todays.length > 0
    ? `today ${formatTokens(tokens)} tok ${todayCost}${unpriced > 0 ? ` (${unpriced} unpriced)` : ''}${partial}`
    : 'today -';

  const burn = fleetBurn(hosts, view.withCache, nowMs);
  const burnCost = burn.costPerHour === null ? '-' : formatRate(burn.costPerHour);
  const burnText = `burn ${burn.tokensPerMinute === null ? '-' : formatTokens(burn.tokensPerMinute)} tok/m ${burnCost}/h`;

  const machines = `${liveHosts.length}/${hosts.length}`;
  const candidates = [
    `crewtop  ${machines} machines · ${agents} · ${todayText} · ${burnText}`,
    `crewtop  ${machines} machines · ${agentTotal} · ${todayText} · ${burnText}`,
  ];
  const text = candidates.find((line) => line.length + clock.length + 2 <= width) ?? `${machines} · ${agentTotal} · ${todayCost} · ${burnCost}/h`;
  const gap = Math.max(2, width - text.length - clock.length);
  return `${BOLD}${text}${RESET}${' '.repeat(gap)}${clock}`;
}

const LOST_TEXT: Record<LostReason, string> = {
  'no-link': 'no ssh link',
  'no-crewtop': 'crewtop not found',
  exited: 'collector exited',
};

function meterLine(hosts: HostModel[], model: HostModel, view: View, nameWidth: number, width: number, nowMs: number): string {
  const host = left(model.host(), nameWidth);
  const status = model.status(nowMs);
  const age = model.liveAgeSeconds(nowMs);
  const reason = model.lostReason();
  if (status === 'unreachable') return `${host} ${RED}[ unreachable ]${RESET}${reason ? ` ${LOST_TEXT[reason]}; retrying` : ''}`;
  if (status === 'update-needed') return `${host} ${YELLOW}[ update needed ]${RESET} its frames do not match this version`;
  if (status === 'waiting') return `${host} ${DIM}[ waiting for collector ]${RESET}`;
  const rows = model.rows(nowMs, view.withCache);
  const live = rows.filter((row) => row.live).length;
  const hidden = rows.length - live;
  const hiddenText = !view.showEnded && hidden > 0 ? `  +${hidden} ended (i)` : '';
  const noun = live === 1 ? 'agent' : 'agents';
  if (status === 'stale') {
    const lost = reason ? `; ${LOST_TEXT[reason]}, retrying` : '';
    const seen = width < BAR_MIN_WIDTH ? `${live} ${noun}` : `last seen ${live} ${noun}`;
    return `${DIM}${host} [ stale ${formatAge(age ?? 0)} ] ${seen}${lost}${RESET}`;
  }
  const burn = model.burn(view.withCache);
  const tokens = burn.tokensPerMinute === null ? '-' : formatTokens(burn.tokensPerMinute);
  const cost = burn.costPerHour === null ? '-' : formatRate(burn.costPerHour);
  const liveAge = `live ${formatAge(age ?? 0)}`;
  if (width < BAR_MIN_WIDTH) return `${host} ${live} ${noun} ${right(cost, 5)}/h ${liveAge}`;
  // The bar is relative to the top $/h among live members.
  const top = Math.max(0, ...hosts.filter((h) => h.status(nowMs) === 'live').map((h) => h.burn(view.withCache).costPerHour ?? 0));
  const share = (burn.costPerHour ?? 0) > 0 ? (burn.costPerHour ?? 0) / top : 0;
  const filled = share > 0 ? Math.max(1, Math.round(share * METER_WIDTH)) : 0;
  const bar = `${GREEN}${'|'.repeat(filled)}${RESET}${'.'.repeat(METER_WIDTH - filled)}`;
  return `${host} [${bar}] ${live} ${noun}  ${right(tokens, 6)} tok/m  ${right(cost, 5)}/h  ${liveAge}${hiddenText}`;
}

function footerLine(view: View, nowMs: number, hosts: HostModel[], width: number): string {
  if (view.prompt) {
    return `${view.prompt.kind === 'find' ? 'find' : 'filter'}: ${view.prompt.text}_  (Enter accept, Esc cancel)`;
  }
  const filter = view.filter ? `filter:${view.filter}  ` : '';
  const rejectedCount = hosts.reduce((sum, host) => sum + host.rejected, 0);
  const rejected = rejectedCount > 0 ? `  rejected ${rejectedCount} frames` : '';
  const errors = hosts.flatMap((host) => host.activeErrors(nowMs).map((code) => (hosts.length > 1 ? `${host.host()}:${code}` : code)));
  // Errors come first: on a narrow screen the clip should cost key hints, not these.
  const errorText = errors.length > 0 ? `${RED}! ${errors.join(' ')}${RESET}  ` : '';
  const keys = width < BAR_MIN_WIDTH
    ? `? help  / find  f filter  s sort  q quit`
    : `F1 help  F3 find  F4 filter  F5 group${view.grouped ? ':on' : ''}  F6 sort:${view.sort}  i ended  c cache${view.withCache ? ':on' : ''}  Enter detail  q quit`;
  return `${errorText}${filter}${keys}${rejected}`;
}

const HELP = [
  'crewtop help (any key closes)',
  '',
  '  Up/Down PgUp/PgDn Home/End   move the selection',
  '  F3 or /                      find a row and jump to it',
  '  F4 or f                      filter rows by host, agent, state, seat or model',
  '  F5 or g                      group rows by machine, or sort across the fleet',
  '  F6 or s                      next sort column; running agents stay on top',
  '  i                            show usage rows with no live agent (ended, or not seen by Herdr)',
  '  c                            add cache tokens to TOK/M',
  '  Enter                        exact counters for the selected row',
  '  q                            quit',
  '',
  '  -    no sample yet. n/a  unsupported by ccusage, or the model has no price. Neither means 0.',
  '  TOK/M and $/H cover a 5 minute window. TOK/M counts input + output unless c is on.',
  '  The first burn figure takes one usage cycle, 15 s or more.',
  '  Cost is notional: the API-equivalent price from ccusage, not what a subscription is charged.',
  "  Today's total is the current UTC day.",
  '  A stale machine is greyed with its age and last values, out of burn and agent counts. If it stays',
  '  lost for 5 minutes its numbers hide. When it returns, burn restarts, so a catch-up draws no spike.',
];

function detailLines(row: Row): string[] {
  const usage = row.usage;
  const lines = [
    `${row.agent} on ${row.host}  ${row.seat ?? '-'}  ${row.state}  (any key closes)`,
    '',
  ];
  if (!usage) {
    lines.push(row.tokens === 'n/a' ? '  tokens n/a: ccusage has no adapter for this agent' : '  no usage sample for this session yet');
    return lines;
  }
  return [
    ...lines,
    `  input         ${usage.i}`,
    `  output        ${usage.o}`,
    `  cache write   ${usage.cw}`,
    `  cache read    ${usage.cr}`,
    `  total         ${usage.i + usage.o + usage.cw + usage.cr}`,
    `  cost          ${usage.c === undefined ? 'n/a' : `$${usage.c.toFixed(4)}`}`,
    `  models        ${usage.m.length > 0 ? usage.m.join(' ') : '-'}`,
    `  last activity ${usage.la ?? '-'}`,
  ];
}

export interface Screen {
  width: number;
  height: number;
  nowMs: number;
  clock: string;
}

const CHROME_LINES = 3; // Header, column titles, footer; plus one meter per member.

export function pageSize(height: number, members = 1): number {
  return Math.max(1, height - CHROME_LINES - members);
}

export function renderScreen(hosts: HostModel[], view: View, { width, height, nowMs, clock }: Screen): string[] {
  const rows = visibleRows(hosts, view, nowMs);
  const page = pageSize(height, hosts.length);
  settle(view, rows, page);
  const names = hosts.map((host) => host.host());
  const columns = columnsFor(width);
  const labels = hostAbbreviations(names);
  const label = (host: string) => (columns === PHONE_COLUMNS ? labels.get(host) ?? host : host);
  const nameWidth = Math.min(MAX_HOST_WIDTH, Math.max(4, ...names.map((name) => name.length)));
  const hostWidth = columns === PHONE_COLUMNS ? Math.max(...names.map((name) => label(name).length), 1) : nameWidth;

  let body: string[];
  if (view.overlay === 'help') {
    body = HELP;
  } else if (view.overlay === 'detail' && rows.length > 0) {
    body = detailLines(rows[selectedIndex(rows, view)]!);
  } else {
    body = rows.slice(view.scroll, view.scroll + page).map((row) => {
      const selected = row.id === view.selected;
      const line = layout(rowCells(row, label(row.host)), columns, hostWidth, !selected && !row.held);
      if (selected) return `${REVERSE}${line.padEnd(width)}${RESET}`;
      return row.held || !row.live ? `${DIM}${line}${RESET}` : line;
    });
    if (rows.length === 0) body = [hosts.every((host) => host.status(nowMs) === 'unreachable') ? '  nothing reachable; retrying' : '  no agents to show'];
  }

  const titles = { ...COLUMN_TITLES, host: columns === PHONE_COLUMNS ? COLUMN_TITLES.host.slice(0, hostWidth) : COLUMN_TITLES.host };
  const lines = [
    headerLine(hosts, view, width, nowMs, clock),
    ...hosts.map((host) => meterLine(hosts, host, view, nameWidth, width, nowMs)),
    `${BOLD}${YELLOW}${layout(titles, columns, hostWidth, false)}${RESET}`,
    ...body.slice(0, page),
  ];
  while (lines.length < height - 1) lines.push('');
  lines.length = Math.max(0, height - 1);
  lines.push(footerLine(view, nowMs, hosts, width));
  return lines.map((line) => clip(line, width));
}
