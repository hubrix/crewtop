import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { test } from 'node:test';
import { HostModel, LOST_HOLD_MS, sortRows, STALE_AFTER_MS } from '../src/tui/model.ts';
import type { Row } from '../src/tui/model.ts';
import { clip, formatAge, formatCost, formatRate, formatTokens, pageSize, renderScreen } from '../src/tui/render.ts';
import { handleKey, newView, parseKeys, visibleRows as fleetRows } from '../src/tui/view.ts';
import type { View } from '../src/tui/view.ts';
import { SAFE_STRING } from '../src/wire.ts';
import type { LiveAgent, UsageRow } from '../src/wire.ts';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const NOW_S = NOW / 1000;

const key = (n: number) => n.toString(16).padStart(12, '0');
const live = (k: number, a: string, st: LiveAgent['st'], extra: Partial<LiveAgent> = {}): LiveAgent => ({ k: key(k), a, st, src: 'herdr', seat: `w${k}:p1`, ...extra });
const usage = (k: number, a: string, tokens: Partial<UsageRow> = {}): UsageRow => ({ k: key(k), a, m: ['claude-opus-5-5'], i: 10, o: 20, cw: 30, cr: 40, c: 1, la: '2026-11-06T11:59:30Z', ...tokens });

function model(agents: LiveAgent[], rows: UsageRow[], usageTs = NOW_S): HostModel {
  const m = new HostModel('hub');
  m.connectionOpened(NOW);
  m.apply({ v: 1, t: 'hello', host: 'hub', os: 'linux', collector: '0.1.0', ccusage: '20.0.48' }, NOW);
  m.apply({ v: 1, t: 'live', ts: NOW_S, agents }, NOW);
  if (rows.length > 0) m.apply({ v: 1, t: 'usage', ts: usageTs, rows }, NOW);
  return m;
}

const screen = (m: HostModel, view: View = newView(), nowMs = NOW, width = 120, height = 30) =>
  renderScreen([m], view, { width, height, nowMs, clock: '12:00:00' });
const visibleRows = (m: HostModel, view: View, nowMs: number) => fleetRows([m], view, nowMs);
const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
const rowFor = (m: HostModel, k: number, withCache = false): Row => m.rows(NOW, withCache).find((r) => r.id.endsWith(key(k)))!;

test('a local model with a $0 cost shows $0, not n/a', () => {
  const m = model([live(1, 'pi', 'working')], [usage(1, 'pi', { m: ['backup'], c: 0 })]);
  const row = rowFor(m, 1);
  assert.equal(row.cost, 0);
  assert.notEqual(row.tokens, 'n/a');
  const line = plain(screen(m)).find((l) => l.includes(' pi '))!;
  assert.match(line, /\$0\.00/);
  assert.doesNotMatch(line, /n\/a/);
});

test('an agent ccusage cannot read shows n/a, never 0', () => {
  const m = model([live(1, 'dsh-tui', 'working'), live(2, 'kiro', 'idle'), live(3, 'muse', 'idle'), live(4, 'omp', 'idle')], [usage(9, 'claude')]);
  for (const k of [1, 2, 3, 4]) {
    const row = rowFor(m, k);
    for (const value of [row.tokens, row.cost, row.tokensPerMinute, row.costPerHour]) assert.equal(value, 'n/a');
  }
  const line = plain(screen(m)).find((l) => l.includes('dsh-tui'))!;
  assert.match(line, /n\/a\s+n\/a\s+n\/a\s+n\/a/);
  assert.doesNotMatch(line, /(^|\s)0(\s|$)/);
});

test('a covered agent with no usage row yet shows -, not 0', () => {
  const m = model([live(1, 'claude', 'working')], []);
  const row = rowFor(m, 1);
  assert.equal(row.tokens, null);
  const line = plain(screen(m)).find((l) => l.includes('claude'))!;
  assert.doesNotMatch(line, /n\/a/);
  assert.match(line, /working\s+-\s+-\s+-\s+-\s+-/);
});

test('tokens are the exact ccusage sum, cost is exact, and joined by key', () => {
  const m = model([live(1, 'claude', 'working')], [usage(1, 'claude', { i: 361, o: 182553, cw: 1404353, cr: 31500339, c: 34.07 })]);
  const row = rowFor(m, 1);
  assert.equal(row.tokens, 361 + 182553 + 1404353 + 31500339);
  assert.equal(row.cost, 34.07);
  const line = plain(screen(m)).find((l) => l.includes('claude') && l.includes('w1'))!;
  assert.match(line, /33\.1M\s+\$34\.07/);
  assert.match(line, /opus-5-5/);
  assert.match(line, /30s/, 'last activity age');
});

test('a session with an unpriced model shows cost n/a but keeps its tokens', () => {
  const noCost = usage(1, 'claude');
  delete noCost.c;
  const row = rowFor(model([live(1, 'claude', 'working')], [noCost]), 1);
  assert.equal(row.tokens, 100);
  assert.equal(row.cost, 'n/a');
  assert.equal(row.costPerHour, 'n/a');
});

test('burn needs two samples, uses input + output only, and c adds cache', () => {
  const m = model([live(1, 'claude', 'working')], [usage(1, 'claude', { i: 100, o: 100, cw: 0, cr: 0, c: 1 })], NOW_S - 60);
  assert.equal(rowFor(m, 1).tokensPerMinute, null);
  assert.equal(rowFor(m, 1).costPerHour, null);
  assert.equal(m.burn(false).tokensPerMinute, null);
  m.apply({ v: 1, t: 'usage', ts: NOW_S, rows: [usage(1, 'claude', { i: 150, o: 150, cw: 1000, cr: 5000, c: 2 })] }, NOW);
  assert.equal(rowFor(m, 1).tokensPerMinute, 100);
  assert.equal(rowFor(m, 1).costPerHour, 60);
  assert.equal(rowFor(m, 1, true).tokensPerMinute, 6100);
  assert.deepEqual(m.burn(false), { tokensPerMinute: 100, costPerHour: 60 });
});

test('burn uses a 5 minute window', () => {
  const m = model([], [usage(1, 'claude', { i: 0, o: 0, c: 0 })], NOW_S - 400);
  m.apply({ v: 1, t: 'usage', ts: NOW_S - 200, rows: [usage(1, 'claude', { i: 1000, o: 0, c: 0 })] }, NOW);
  m.apply({ v: 1, t: 'usage', ts: NOW_S, rows: [usage(1, 'claude', { i: 3000, o: 0, c: 0 })] }, NOW);
  assert.equal(m.burn(false).tokensPerMinute, 600);
});

test('burn resets when a counter decreases, so there is no false spike', () => {
  const m = model([], [usage(1, 'claude', { i: 1000 })], NOW_S - 60);
  m.apply({ v: 1, t: 'usage', ts: NOW_S - 30, rows: [usage(1, 'claude', { i: 5 })] }, NOW);
  assert.equal(m.burn(false).tokensPerMinute, null);
  m.apply({ v: 1, t: 'usage', ts: NOW_S, rows: [usage(1, 'claude', { i: 35 })] }, NOW);
  assert.equal(m.burn(false).tokensPerMinute, 60);
});

test('burn resets on reconnect, so a catch-up cannot draw a spike', () => {
  const m = model([], [usage(1, 'claude', { i: 1000 })], NOW_S - 60);
  m.connectionLost(NOW);
  m.connectionOpened(NOW);
  m.apply({ v: 1, t: 'usage', ts: NOW_S, rows: [usage(1, 'claude', { i: 900000 })] }, NOW);
  assert.equal(m.burn(false).tokensPerMinute, null);
});

test('three missed live frames grey the machine with its age; values remain', () => {
  const m = model([live(1, 'claude', 'working')], [usage(1, 'claude')]);
  assert.equal(m.status(NOW + 2000), 'live');
  const later = NOW + STALE_AFTER_MS + 34_000;
  assert.equal(m.status(later), 'stale');
  const lines = screen(m, newView(), later);
  assert.match(plain(lines)[1]!, /stale 41s/);
  assert.match(plain(lines).join('\n'), /claude/, 'last values stay on screen');
  assert.match(plain(lines)[0]!, /0\/1 machines/);
});

test('a lost collector holds its last values greyed, then hides them after the hold', () => {
  const m = model([live(1, 'claude', 'working')], [usage(1, 'claude', { i: 123456 })]);
  m.apply({ v: 1, t: 'today', ts: NOW_S, i: 1, o: 1, cw: 1, cr: 777_000_000, c: 88.88, unpriced: [] }, NOW);
  m.apply({ v: 1, t: 'usage', ts: NOW_S + 60, rows: [usage(1, 'claude', { i: 123456 + 5000 })] }, NOW);
  assert.match(plain(screen(m, newView(), NOW, 140))[0]!, /today 777\.0M tok \$88\.88 · burn 5\.0k tok\/m/);
  m.connectionLost(NOW);
  assert.equal(m.status(NOW), 'stale');
  assert.ok(m.rows(NOW, false).every((row) => row.held), 'values are held the moment the link drops');
  assert.match(plain(screen(m, newView(), NOW, 140))[0]!, /today 777\.0M tok \$88\.88 · burn - tok\/m -\/h/);
  const expired = NOW + LOST_HOLD_MS + 1;
  assert.equal(m.status(expired), 'unreachable');
  assert.match(plain(screen(m, newView(), expired, 140))[0]!, /today - · burn - tok\/m -\/h/);
  assert.deepEqual(m.rows(expired, false), []);
  const text = plain(screen(m, newView(), expired)).join('\n');
  assert.match(text, /unreachable/);
  assert.doesNotMatch(text, /123\.6k|777\.0M|88\.88/);
  assert.doesNotMatch(text, /claude/);
});

test('before any frame the screen says waiting, not zero', () => {
  const text = plain(screen(new HostModel())).join('\n');
  assert.match(text, /waiting for collector/);
  assert.match(text, /today -/);
  assert.match(text, /burn - tok\/m -\/h/);
});

test('the local view reads its own hostname and ignores the one on the wire', () => {
  const m = new HostModel();
  m.apply({ v: 1, t: 'hello', host: 'from-the-wire', os: 'linux', collector: '0.1.0', ccusage: '20.0.48' }, NOW);
  assert.equal(m.host(), SAFE_STRING.test(hostname()) ? hostname() : 'local');
  assert.equal(new HostModel('configured').host(), 'configured');
});

test('each withheld unpriced name counts once, and a named one once across machines', () => {
  const m = model([live(1, 'claude', 'working')], []);
  const today = { v: 1, t: 'today', ts: NOW_S, i: 1, o: 1, cw: 1, cr: 1, c: 1 } as const;
  m.apply({ ...today, unpriced: ['other', 'other', 'claude-opus-9'] }, NOW);
  const peer = model([live(2, 'claude', 'working')], []);
  peer.apply({ ...today, unpriced: ['other', 'claude-opus-9'] }, NOW);
  const header = plain(renderScreen([m, peer], newView(), { width: 120, height: 30, nowMs: NOW, clock: '12:00:00' }))[0]!;
  assert.match(header, /\(4 unpriced\)/);
});

test('errors appear as closed codes and clear on success', () => {
  const m = model([live(1, 'claude', 'working')], []);
  m.apply({ v: 1, t: 'err', code: 'ccusage_failed' }, NOW);
  m.apply({ v: 1, t: 'err', code: 'herdr_unavailable' }, NOW);
  assert.match(plain(screen(m)).at(-1)!, /! ccusage_failed herdr_unavailable/);
  m.apply({ v: 1, t: 'usage', ts: NOW_S, rows: [] }, NOW);
  assert.deepEqual(m.activeErrors(NOW), ['herdr_unavailable']);
  assert.deepEqual(m.activeErrors(NOW + 11_000), []);
});

test('header counts agents by state and shows today and burn', () => {
  const m = model([live(1, 'claude', 'working'), live(2, 'pi', 'working'), live(3, 'dsh-tui', 'blocked'), live(4, 'codex', 'idle')], []);
  m.apply({ v: 1, t: 'today', ts: NOW_S, i: 1, o: 2, cw: 3, cr: 212_399_994, c: 96.1, unpriced: ['x'] }, NOW);
  const header = plain(screen(m, newView(), NOW, 140))[0]!;
  assert.match(header, /1\/1 machines · 4 agents: 2 working 1 blocked 1 idle/);
  assert.match(header, /today 212\.4M tok \$96\.10 \(1 unpriced\)/);
  assert.match(header, /12:00:00$/);
});

test('default order: running first, then $/h descending, with unknowns last', () => {
  const m = model([live(1, 'claude', 'idle'), live(2, 'claude', 'working'), live(3, 'claude', 'working'), live(4, 'dsh-tui', 'working')], [usage(1, 'claude', { c: 0 }), usage(2, 'claude', { c: 0 }), usage(3, 'claude', { c: 0 })], NOW_S - 60);
  m.apply({ v: 1, t: 'usage', ts: NOW_S, rows: [usage(1, 'claude', { c: 500 }), usage(2, 'claude', { c: 1 }), usage(3, 'claude', { c: 2 })] }, NOW);
  const order = sortRows(m.rows(NOW, false), '$/h').map((row) => `${row.agent}:${row.seat}`);
  assert.deepEqual(order, ['claude:w3:p1', 'claude:w2:p1', 'dsh-tui:w4:p1', 'claude:w1:p1']);
});

test('F6 cycles sort columns', () => {
  const view = newView();
  handleKey(view, 'f6', [], 10);
  assert.equal(view.sort, 'tok/m');
  for (let i = 0; i < 6; i++) handleKey(view, 's', [], 10);
  assert.equal(view.sort, '$/h');
});

test('i reveals usage rows with no live agent, marked unknown, and the meter counts them', () => {
  const m = model([live(1, 'claude', 'working')], [usage(1, 'claude'), usage(2, 'claude'), usage(3, 'pi')]);
  const view = newView();
  assert.equal(visibleRows(m, view, NOW).length, 1);
  assert.match(plain(screen(m, view))[1]!, /\+2 ended \(i\)/);
  handleKey(view, 'i', [], 10);
  const rows = visibleRows(m, view, NOW);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.live, true, 'the live agent stays on top');
  assert.ok(rows.slice(1).every((row) => !row.live && row.state === 'unknown'));
  assert.equal(plain(screen(m))[0]!.includes('3 agents'), false, 'ended sessions are not counted as agents');
});

test('F4 filters by host, agent or state, and Esc cancels', () => {
  const m = model([live(1, 'claude', 'working'), live(2, 'dsh-tui', 'blocked')], []);
  const view = newView();
  const type = (text: string) => {
    for (const key of parseKeys(text)) handleKey(view, key, visibleRows(m, view, NOW), 10);
  };
  type('\x1bOS');
  type('dsh');
  assert.deepEqual(visibleRows(m, view, NOW).map((r) => r.agent), ['dsh-tui'], 'filters while typing');
  type('\r');
  assert.equal(view.filter, 'dsh');
  assert.match(plain(screen(m, view)).at(-1)!, /filter:dsh/);
  type('f');
  type('\x7f\x7f\x7fBLOCK\r');
  assert.deepEqual(visibleRows(m, view, NOW).map((r) => r.agent), ['dsh-tui'], 'case-insensitive, by state');
  type('f');
  type('\x7f\x7f\x7f\x7f\x7fhub\r');
  assert.equal(visibleRows(m, view, NOW).length, 2, 'by host');
  type('f');
  type('zzz');
  type('\x1b');
  assert.equal(view.filter, 'hub', 'Esc keeps the previous filter');
});

test('F3 finds a row and moves the selection to it', () => {
  const m = model([live(1, 'claude', 'working'), live(2, 'claude', 'working'), live(3, 'dsh-tui', 'working')], []);
  const view = newView();
  screen(m, view);
  for (const key of parseKeys('/dsh\r')) handleKey(view, key, visibleRows(m, view, NOW), 10);
  assert.equal(visibleRows(m, view, NOW).find((r) => r.id === view.selected)!.agent, 'dsh-tui');
});

test('arrows, pages and scrolling keep the selection on screen', () => {
  const agents = Array.from({ length: 50 }, (_, i) => live(i + 1, 'claude', 'working'));
  const m = model(agents, []);
  const view = newView();
  const height = 12;
  screen(m, view, NOW, 120, height);
  const page = pageSize(height);
  handleKey(view, 'pagedown', visibleRows(m, view, NOW), page);
  handleKey(view, 'down', visibleRows(m, view, NOW), page);
  const lines = screen(m, view, NOW, 120, height);
  assert.equal(lines.length, height);
  assert.equal(view.scroll, 9 - page + 1);
  assert.ok(lines.some((line) => line.includes('\x1b[7m')), 'the selected row is highlighted');
  handleKey(view, 'end', visibleRows(m, view, NOW), page);
  screen(m, view, NOW, 120, height);
  assert.equal(view.scroll, 50 - page);
  handleKey(view, 'home', visibleRows(m, view, NOW), page);
  screen(m, view, NOW, 120, height);
  assert.equal(view.scroll, 0);
});

test('Enter opens exact counters; help explains n/a and notional cost; q quits', () => {
  const m = model([live(1, 'claude', 'working')], [usage(1, 'claude', { i: 361, o: 182553, cw: 1404353, cr: 31500339, c: 34.07 })]);
  const view = newView();
  screen(m, view);
  handleKey(view, 'enter', visibleRows(m, view, NOW), 10);
  const detail = plain(screen(m, view)).join('\n');
  assert.match(detail, /input\s+361\b/);
  assert.match(detail, /total\s+33087606\b/);
  handleKey(view, 'x', [], 10);
  assert.equal(view.overlay, null);
  handleKey(view, 'f1', [], 10);
  const help = plain(screen(m, view, NOW, 200, 30)).join('\n');
  assert.match(help, /Neither means 0/);
  assert.match(help, /notional/);
  handleKey(view, 'x', [], 10);
  handleKey(view, 'q', [], 10);
  assert.equal(view.quit, true);
});

test('Ctrl-C quits from a prompt too', () => {
  const view = newView();
  handleKey(view, 'f3', [], 10);
  handleKey(view, 'ctrl-c', [], 10);
  assert.equal(view.quit, true);
});

test('every line fits the terminal, including a very narrow one', () => {
  const m = model([live(1, 'antigravity', 'working')], [usage(1, 'antigravity')]);
  for (const width of [200, 80, 40, 10]) {
    for (const line of plain(screen(m, newView(), NOW, width, 10))) assert.ok(line.length <= width, `${line.length} > ${width}`);
  }
  assert.equal(screen(m, newView(), NOW, 80, 5).length, 5);
});

test('clip keeps colour sequences and counts only visible characters', () => {
  assert.equal(clip('\x1b[32mabcdef\x1b[0m', 3), '\x1b[32mabc\x1b[0m\x1b[0m');
});

test('number formats match the design mock', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(9_900), '9.9k');
  assert.equal(formatTokens(33_100_000), '33.1M');
  assert.equal(formatTokens(1_600_000_000), '1.6G');
  assert.equal(formatCost(34.07), '$34.07');
  assert.equal(formatCost(1234.5), '$1235');
  assert.equal(formatRate(25.2), '$25');
  assert.equal(formatRate(4.2), '$4.20');
  assert.equal(formatRate(0), '$0');
  assert.equal(formatAge(4), '4s');
  assert.equal(formatAge(180), '3m');
  assert.equal(formatAge(7200), '2h');
  assert.equal(formatAge(90_000), '1d');
});

test('unknown escape sequences do not act as keys', () => {
  assert.deepEqual(parseKeys('\x1b[99~q'), ['', 'q']);
  assert.deepEqual(parseKeys('\x1b[A\x1b[B\r'), ['up', 'down', 'enter']);
  assert.deepEqual(parseKeys('\x1bOP\x1bOR\x1bOS\x1b[17~'), ['f1', 'f3', 'f4', 'f6']);
});
