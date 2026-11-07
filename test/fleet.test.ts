import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PACKAGE_ROOT } from '../src/collect/ccusage.ts';
import { defaultFleetConfigPath, FleetConfigError, loadFleetConfig, parseFleetConfig } from '../src/fleet/config.ts';
import { collectorCommand, lostReason, MemberLink } from '../src/fleet/link.ts';
import { HostModel, LOST_HOLD_MS, STALE_AFTER_MS } from '../src/tui/model.ts';
import { hostAbbreviations, pageSize, renderScreen } from '../src/tui/render.ts';
import { handleKey, newView, visibleRows } from '../src/tui/view.ts';
import type { View } from '../src/tui/view.ts';
import type { LiveAgent, UsageRow } from '../src/wire.ts';
import { CREWTOP_BIN, tempDir, writeScript } from './helpers.ts';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const NOW_S = NOW / 1000;
const root = tempDir('crewtop-fleet-');
after(() => rmSync(root, { recursive: true, force: true }));

const key = (n: number) => n.toString(16).padStart(12, '0');
const live = (k: number, a: string, st: LiveAgent['st']): LiveAgent => ({ k: key(k), a, st, src: 'herdr', seat: `w${k}:p1` });
const usage = (k: number, a: string, tokens: Partial<UsageRow> = {}): UsageRow => ({ k: key(k), a, m: ['claude-opus-5-5'], i: 10, o: 20, cw: 30, cr: 40, c: 1, ...tokens });
const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));

/** A member with one agent and a burn of 600 tok/m and $60/h, as a live collector would report it. */
function member(name: string, k: number, wireHost = name): HostModel {
  const m = new HostModel(name);
  m.connectionOpened(NOW);
  m.apply({ v: 1, t: 'hello', host: wireHost, os: 'linux', collector: '0.1.0', ccusage: '20.0.48' }, NOW);
  m.apply({ v: 1, t: 'live', ts: NOW_S, agents: [live(k, 'claude', 'working')] }, NOW);
  m.apply({ v: 1, t: 'usage', ts: NOW_S - 60, rows: [usage(k, 'claude', { i: 1000, o: 0, c: 1 })] }, NOW);
  m.apply({ v: 1, t: 'usage', ts: NOW_S, rows: [usage(k, 'claude', { i: 1600, o: 0, c: 2 })] }, NOW);
  m.apply({ v: 1, t: 'today', ts: NOW_S, i: 1000, o: 0, cw: 0, cr: 0, c: 5, unpriced: [] }, NOW);
  return m;
}

const screen = (hosts: HostModel[], nowMs = NOW, width = 140, height = 30, view: View = newView()) =>
  renderScreen(hosts, view, { width, height, nowMs, clock: '12:00:00' });
const lineWith = (lines: string[], text: string) => lines.find((line) => line.includes(text))!;

// --- The config file ---

test('the shipped example lists three members', () => {
  const members = loadFleetConfig(join(PACKAGE_ROOT, 'fleet.example.toml'));
  assert.deepEqual(members, [
    { name: 'hub', ssh: null },
    { name: 'box-a', ssh: 'box-a' },
    { name: 'box-b', ssh: 'box-b' },
  ]);
});

test('comments and user@host targets are accepted', () => {
  const members = parseFleetConfig('# top\n[[member]] # a table\nname = "box" # a comment\nssh = "mark@box.example.net"\n');
  assert.deepEqual(members, [{ name: 'box', ssh: 'mark@box.example.net' }]);
});

const BAD_CONFIGS: [string, string, RegExp][] = [
  ['an empty file', '# nothing\n', /no \[\[member\]\]/],
  ['a key before any table', 'name = "x"\n', /line 1: expected \[\[member\]\]/],
  ['a mistyped key', '[[member]]\nname = "x"\nhost = "x"\n', /line 3: unknown or mistyped key host/],
  ['a repeated key', '[[member]]\nname = "x"\nname = "y"\nlocal = true\n', /line 3: name is set twice/],
  ['a bare value', '[[member]]\nname = x\n', /line 2/],
  ['a member with no name', '[[member]]\nlocal = true\n', /line 1: member has no name/],
  ['a member with no target', '[[member]]\nname = "x"\n', /needs ssh/],
  ['local and ssh together', '[[member]]\nname = "x"\nlocal = true\nssh = "x"\n', /both local and ssh/],
  ['two local members', '[[member]]\nname = "x"\nlocal = true\n[[member]]\nname = "y"\nlocal = true\n', /more than one/],
  ['a duplicate name', '[[member]]\nname = "x"\nssh = "a"\n[[member]]\nname = "x"\nssh = "b"\n', /used twice/],
  ['an unsafe name', '[[member]]\nname = "a b"\nssh = "a"\n', /name must match/],
  ['a target ssh would read as an option', '[[member]]\nname = "x"\nssh = "-oProxyCommand=evil"\n', /invalid ssh target/],
  ['a user that looks like an option', '[[member]]\nname = "x"\nssh = "-l@box"\n', /invalid ssh target/],
  ['a target with a space', '[[member]]\nname = "x"\nssh = "a b"\n', /invalid ssh target/],
  ['a target with shell characters', '[[member]]\nname = "x"\nssh = "a;id"\n', /invalid ssh target/],
];

for (const [what, text, message] of BAD_CONFIGS) {
  test(`config rejects ${what}`, () => {
    assert.throws(() => parseFleetConfig(text), (error: Error) => error instanceof FleetConfigError && message.test(error.message));
  });
}

test('the config path follows XDG_CONFIG_HOME, then HOME', () => {
  assert.equal(defaultFleetConfigPath({ HOME: '/h' }), '/h/.config/crewtop/fleet.toml');
  assert.equal(defaultFleetConfigPath({ HOME: '/h', XDG_CONFIG_HOME: '/x' }), '/x/crewtop/fleet.toml');
  assert.equal(defaultFleetConfigPath({ HOME: '/h', XDG_CONFIG_HOME: 'relative' }), '/h/.config/crewtop/fleet.toml');
});

test('only the default path may be absent', () => {
  const missing = join(root, 'absent.toml');
  assert.equal(loadFleetConfig(missing, true), null);
  assert.throws(() => loadFleetConfig(missing), FleetConfigError);
});

const runCli = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [CREWTOP_BIN, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });

test('a bad config stops with its line number, before touching the terminal', () => {
  const path = join(root, 'bad.toml');
  writeFileSync(path, '[[member]]\nname = "x"\nhots = "typo"\n');
  const result = runCli(['--fleet', path]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /bad\.toml: line 3: unknown or mistyped key hots/);
  assert.equal(result.stdout, '');
});

test('without a config, or with --local, crewtop opens the one-machine view', () => {
  for (const args of [[], ['--local']]) {
    const result = runCli(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /needs a terminal/);
  }
});

test('--fleet needs a path and an explicit path must exist', () => {
  assert.equal(runCli(['--fleet']).status, 2);
  const result = runCli(['--fleet', join(root, 'absent.toml')]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot read the file/);
});

// --- The SSH command ---

test('ssh runs only the fixed collector command, with keepalives and no prompts', () => {
  const { file, args } = collectorCommand({ name: 'box-b', ssh: 'box-b' });
  assert.equal(file, 'ssh');
  assert.deepEqual(args.slice(-5), ['--', 'box-b', 'crewtop', 'collect', '--stream']);
  const text = args.join(' ');
  for (const option of ['BatchMode=yes', 'ServerAliveInterval=5', 'ServerAliveCountMax=2', 'ControlPath=none', 'ForwardAgent=no']) assert.ok(text.includes(option), option);
  assert.doesNotMatch(text, /StrictHostKeyChecking/, 'the hub must not start accepting new host keys');
});

test('the local member runs the collector directly, without ssh', () => {
  const { file, args, cwd } = collectorCommand({ name: 'hub', ssh: null });
  assert.equal(file, process.execPath);
  assert.deepEqual(args.slice(-2), ['collect', '--stream']);
  assert.equal(cwd, '/', 'it must not inherit the directory the dashboard was launched from');
});

test('exit codes map to a closed list of reasons', () => {
  assert.equal(lostReason(true, 255), 'no-link');
  assert.equal(lostReason(true, null), 'no-link');
  assert.equal(lostReason(true, -2), 'no-link');
  assert.equal(lostReason(true, 127), 'no-crewtop');
  assert.equal(lostReason(true, 126), 'no-crewtop');
  assert.equal(lostReason(true, 1), 'exited');
  assert.equal(lostReason(false, 127), 'exited');
});

// --- The aggregated view ---

test('every member shows together, labelled by its configured name', () => {
  const hosts = [member('hub', 1), member('box-b', 2, 'BOX-B')];
  const lines = plain(screen(hosts));
  assert.match(lines[0]!, /2\/2 machines · 2 agents: 2 working/);
  assert.match(lines[0]!, /today 2\.0k tok \$10\.00/);
  assert.match(lines[0]!, /burn 1\.2k tok\/m \$120\/h/);
  assert.match(lines[1]!, /^hub\s+\[/);
  assert.match(lines[2]!, /^box-b\s+\[/);
  assert.match(lineWith(lines, 'w1:p1'), /^hub /);
  assert.match(lineWith(lines, 'w2:p1'), /^box-b /);
  assert.doesNotMatch(lines.join('\n'), /BOX-B/, "the config name replaces the machine's own hostname");
});

test('the same session key on two members stays two rows with their own selection', () => {
  const hosts = [member('a', 1), member('b', 1)];
  const rows = visibleRows(hosts, newView(), NOW);
  assert.equal(new Set(rows.map((row) => row.id)).size, 2);
});

test('a member with no live frames greys within 10 s and holds its last values', () => {
  const quiet = member('quiet', 1);
  const busy = member('busy', 2);
  const later = NOW + STALE_AFTER_MS + 1;
  assert.ok(later - NOW < 10_000);
  busy.apply({ v: 1, t: 'live', ts: NOW_S + 7, agents: [live(2, 'claude', 'working')] }, later);
  assert.equal(quiet.status(later), 'stale');
  assert.equal(busy.status(later), 'live');
  const raw = screen([quiet, busy], later);
  const lines = plain(raw);
  assert.match(lines[1]!, /quiet\s+\[ stale 7s \] last seen 1 agent/);
  assert.match(lines[0]!, /1\/2 machines · 1 agent: 1 working/, 'held agents are not counted as running now');
  assert.match(lines[0]!, /burn 600 tok\/m \$60\/h/, 'held burn is not added');
  assert.match(lines[0]!, /today 2\.0k tok \$10\.00/, "today's totals keep the held member");
  assert.match(lineWith(lines, 'w1:p1'), /1\.7k\s+\$2\.00/, 'tokens and cost are held');
  assert.ok(lineWith(raw, 'w1:p1').includes('\x1b[2m') || lineWith(raw, 'w1:p1').includes('\x1b[7m'), 'the held row is grey or selected');
  assert.ok(lineWith(raw, 'w2:p1').includes('\x1b[32m'), 'the other member keeps its colour');
  assert.ok(!lineWith(raw, 'w2:p1').includes('\x1b[2m'));
});

test("a member's status never changes another member's row", () => {
  // The first member's row takes the selection, so the row under test is never highlighted.
  const busyLine = (other: HostModel) => lineWith(screen([member('first', 9), other, member('busy', 2)]), 'w2:p1');
  const reference = busyLine(member('other', 1));
  const failed = new HostModel('other');
  failed.connectionLost(NOW, 'no-link');
  const lost = member('other', 1);
  lost.connectionLost(NOW - LOST_HOLD_MS - 1, 'no-link');
  const incompatible = new HostModel('other');
  incompatible.connectionOpened(NOW);
  incompatible.frameRejected();
  for (const other of [new HostModel('other'), failed, lost, incompatible]) assert.equal(busyLine(other), reference);
});

test('SSH failure shows as unreachable, with a reason from the closed list', () => {
  const noLink = new HostModel('down');
  noLink.connectionLost(NOW, 'no-link');
  const noCrewtop = new HostModel('bare');
  noCrewtop.connectionLost(NOW, 'no-crewtop');
  const lines = plain(screen([noLink, noCrewtop, member('up', 3)]));
  assert.match(lines[1]!, /down\s+\[ unreachable \] no ssh link; retrying/);
  assert.match(lines[2]!, /bare\s+\[ unreachable \] crewtop not found; retrying/);
  assert.match(lines[0]!, /1\/3 machines/);
  assert.match(lines[0]!, /\(1\/3 machines\)/, 'partial totals say so');
  assert.match(lineWith(lines, 'w3:p1'), /^up /);
});

test('with nothing reachable the screen says so, and shows no zeros', () => {
  const a = new HostModel('a');
  a.connectionLost(NOW, 'no-link');
  const text = plain(screen([a]));
  assert.match(text[0]!, /0\/1 machines · agents - · today - · burn - tok\/m -\/h/);
  assert.match(text.join('\n'), /nothing reachable; retrying/);
});

test('losing the link holds values at once; the hold then expires, and failed retries do not extend it', () => {
  const m = member('box-b', 1);
  m.connectionLost(NOW, 'no-link');
  assert.equal(m.status(NOW), 'stale');
  assert.match(plain(screen([m], NOW + 12_000))[1]!, /box-b\s+\[ stale 12s \] last seen 1 agent; no ssh link, retrying/);
  m.connectionLost(NOW + 60_000, 'no-link');
  assert.equal(m.status(NOW + LOST_HOLD_MS), 'stale');
  const expired = NOW + LOST_HOLD_MS + 1;
  assert.equal(m.status(expired), 'unreachable');
  assert.deepEqual(m.rows(expired, false), []);
  assert.equal(m.todayShown(expired), null);
});

test('recovery shows no false burn spike, and burn resumes from the next sample', () => {
  const m = member('box-b', 1);
  assert.equal(m.burn(false).tokensPerMinute, 600);
  const back = NOW + 120_000;
  m.connectionLost(NOW, 'no-link');
  m.connectionOpened(back);
  assert.equal(m.burn(false).tokensPerMinute, null, 'the pre-outage samples are gone');
  assert.equal(m.status(back), 'stale', 'held until a live frame proves it is back');
  assert.equal(m.rows(back, false).length, 1, 'no blank flash between connect and the first frame');
  m.apply({ v: 1, t: 'live', ts: NOW_S + 120, agents: [live(1, 'claude', 'working')] }, back);
  assert.equal(m.status(back), 'live');
  // 90,000 tokens were spent while it was away. None of that may read as a rate.
  m.apply({ v: 1, t: 'usage', ts: NOW_S + 120, rows: [usage(1, 'claude', { i: 91_600, o: 0, c: 500 })] }, back);
  assert.equal(m.burn(false).tokensPerMinute, null);
  assert.equal(m.burn(false).costPerHour, null);
  assert.match(plain(screen([m], back))[0]!, /burn - tok\/m -\/h/);
  assert.match(lineWith(plain(screen([m], back)), 'w1:p1'), /working\s+opus-5-5\s+-\s+-\s+91\.7k/);
  m.apply({ v: 1, t: 'usage', ts: NOW_S + 180, rows: [usage(1, 'claude', { i: 92_200, o: 0, c: 501 })] }, back + 60_000);
  assert.equal(m.burn(false).tokensPerMinute, 600);
});

test('coming back after the hold starts from nothing, so hidden numbers do not flash', () => {
  const m = member('box-b', 1);
  m.connectionLost(NOW, 'no-link');
  const back = NOW + LOST_HOLD_MS + 1;
  m.connectionOpened(back);
  assert.equal(m.status(back), 'waiting');
  assert.deepEqual(m.rows(back, false), []);
  assert.equal(m.today, null);
});

test('a collector this build cannot read shows update needed and stays out of the totals', () => {
  const m = new HostModel('old');
  m.connectionOpened(NOW);
  assert.equal(m.status(NOW), 'waiting');
  m.frameRejected();
  assert.equal(m.status(NOW), 'update-needed');
  const lines = plain(screen([m, member('up', 2)]));
  assert.match(lines[1]!, /old\s+\[ update needed \]/);
  assert.match(lines[0]!, /1\/2 machines/);
  assert.match(lines.at(-1)!, /rejected 1 frames/);
});

test('a login banner before the first frame does not read as a version mismatch', () => {
  const m = new HostModel('chatty');
  m.connectionOpened(NOW);
  m.frameRejected();
  m.apply({ v: 1, t: 'hello', host: 'chatty', os: 'linux', collector: '0.1.0', ccusage: '20.0.48' }, NOW);
  assert.equal(m.status(NOW), 'waiting');
});

test('a slow usage frame from one member only delays that member', () => {
  const slow = member('slow', 1);
  const quick = member('quick', 2);
  const later = NOW + 60_000;
  slow.apply({ v: 1, t: 'live', ts: NOW_S + 60, agents: [live(1, 'claude', 'working')] }, later);
  quick.apply({ v: 1, t: 'live', ts: NOW_S + 60, agents: [live(2, 'claude', 'working')] }, later);
  quick.apply({ v: 1, t: 'usage', ts: NOW_S + 60, rows: [usage(2, 'claude', { i: 2200, o: 0, c: 3 })] }, later);
  assert.equal(slow.status(later), 'live');
  assert.equal(quick.burn(false).tokensPerMinute, 600);
  assert.equal(slow.burn(false).tokensPerMinute, 600);
});

test('rows group by member in config order, and F5 sorts across the fleet instead', () => {
  const low = member('low', 1);
  const high = new HostModel('high');
  high.connectionOpened(NOW);
  high.apply({ v: 1, t: 'live', ts: NOW_S, agents: [live(2, 'claude', 'working')] }, NOW);
  high.apply({ v: 1, t: 'usage', ts: NOW_S - 60, rows: [usage(2, 'claude', { c: 1 })] }, NOW);
  high.apply({ v: 1, t: 'usage', ts: NOW_S, rows: [usage(2, 'claude', { c: 500 })] }, NOW);
  const view = newView();
  assert.deepEqual(visibleRows([low, high], view, NOW).map((row) => row.host), ['low', 'high']);
  handleKey(view, 'f5', [], 10);
  assert.equal(view.grouped, false);
  assert.deepEqual(visibleRows([low, high], view, NOW).map((row) => row.host), ['high', 'low']);
  high.connectionLost(NOW, 'no-link');
  assert.deepEqual(visibleRows([low, high], view, NOW).map((row) => row.host), ['low', 'high'], 'held rows sink below live ones');
  handleKey(view, 'g', [], 10);
  assert.equal(view.grouped, true);
});

test('each machine has a meter line, scaled to the top live burn, and the page shrinks to fit', () => {
  const top = new HostModel('top');
  top.connectionOpened(NOW);
  top.apply({ v: 1, t: 'live', ts: NOW_S, agents: [live(1, 'claude', 'working')] }, NOW);
  top.apply({ v: 1, t: 'usage', ts: NOW_S - 300, rows: [usage(1, 'claude', { c: 0 })] }, NOW);
  top.apply({ v: 1, t: 'usage', ts: NOW_S, rows: [usage(1, 'claude', { c: 100 })] }, NOW);
  const half = new HostModel('half');
  half.connectionOpened(NOW);
  half.apply({ v: 1, t: 'live', ts: NOW_S, agents: [live(2, 'claude', 'working')] }, NOW);
  half.apply({ v: 1, t: 'usage', ts: NOW_S - 300, rows: [usage(2, 'claude', { c: 0 })] }, NOW);
  half.apply({ v: 1, t: 'usage', ts: NOW_S, rows: [usage(2, 'claude', { c: 50 })] }, NOW);
  const lines = plain(screen([top, half]));
  assert.match(lines[1]!, /\[\|{24}\]/);
  assert.match(lines[2]!, /\[\|{12}\.{12}\]/);
  assert.equal(pageSize(30), 26);
  assert.equal(pageSize(30, 3), 24);
  assert.equal(pageSize(5, 3), 1);
});

test('narrow terminals drop columns in the order the design sets', () => {
  const hosts = [member('hub', 1), member('box-a', 2), member('box-b', 3)];
  const titles = (width: number) => plain(screen(hosts, NOW, width))[4]!;
  assert.match(titles(120), /MODEL.*UP$/);
  const medium = titles(99);
  assert.doesNotMatch(medium, /MODEL|\bUP\b/);
  assert.match(medium, /TOKENS/);
  const narrow = titles(79);
  assert.doesNotMatch(narrow, /TOKENS/);
  assert.match(narrow, /SEAT.*\$\/H.*COST/);
  const phone = titles(59);
  assert.doesNotMatch(phone, /SEAT|TOK\/M|COST/);
  assert.match(phone, /AGENT\s+STATE\s+\$\/H/);
});

test('a phone-width table tells apart box and box-a, and meters keep full names', () => {
  assert.deepEqual([...hostAbbreviations(['box-a', 'box', 'hub'])], [['box-a', 'ba'], ['box', 'b'], ['hub', 'h']]);
  assert.deepEqual([...hostAbbreviations(['box-a', 'bar-a'])].map(([, label]) => label), ['b1', 'b2']);
  const hosts = [member('hub', 1), member('box-a', 2), member('box-b', 3)];
  const lines = plain(screen(hosts, NOW, 44, 16));
  assert.match(lines[1]!, /^hub\s+1 agent/);
  assert.match(lines[3]!, /^box-b\s+1 agent/);
  assert.match(lines.find((line) => line.startsWith('ba '))!, /^ba claude\s+working\s+\$60\s*$/);
  assert.ok(lines.some((line) => line.startsWith('h  claude')));
  assert.ok(lines.some((line) => line.startsWith('bb claude')));
  assert.match(lines[0]!, /^3\/3 · 3 agents · \$15\.00 · \$180\/h/);
  const lost = member('box-b', 3);
  lost.connectionLost(NOW, 'no-link');
  assert.match(plain(screen([lost], NOW + 12_000, 44, 16))[1]!, /^box-b \[ stale 12s \] 1 agent; no ssh link/, 'the count survives the clip');
});

test('every line fits at every width with several members, in every status', () => {
  const stale = member('stale-member', 1);
  stale.connectionLost(NOW, 'no-link');
  const down = new HostModel('down-member');
  down.connectionLost(NOW, 'no-crewtop');
  const hosts = [member('a-rather-long-member-name-indeed', 2), stale, down, new HostModel('waiting-member')];
  for (const width of [200, 100, 99, 80, 79, 60, 59, 40, 20]) {
    for (const height of [30, 8, 3]) {
      const lines = plain(screen(hosts, NOW, width, height));
      assert.equal(lines.length, height);
      for (const line of lines) assert.ok(line.length <= width, `${line.length} > ${width}`);
    }
  }
});

test('errors name their member once there is more than one', () => {
  const a = member('a', 1);
  a.apply({ v: 1, t: 'err', code: 'herdr_unavailable' }, NOW);
  assert.match(plain(screen([a, member('b', 2)])).at(-1)!, /^! a:herdr_unavailable/);
  assert.match(plain(screen([a])).at(-1)!, /^! herdr_unavailable/);
});

// --- Real child processes behind the link ---

const LIVE_LINE = (ts = 1793940923) => `{"v":1,"t":"live","ts":${ts},"agents":[]}`;
const HELLO_LINE = '{"v":1,"t":"hello","host":"fake","os":"linux","collector":"0.1.0","ccusage":"20.0.48"}';
const QUICK = { retryMinMs: 20, retryMaxMs: 40, watchdogMs: 5_000 };

async function until(what: string, condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const sshBinDir = tempDir('crewtop-fake-ssh-');
after(() => rmSync(sshBinDir, { recursive: true, force: true }));
let scripts = 0;
const fakeSsh = (body: string) => writeScript(sshBinDir, `ssh-${++scripts}`, body);

function link(name: string, sshBin: string, options: object = QUICK): { model: HostModel; link: MemberLink } {
  const model = new HostModel(name);
  const memberLink = new MemberLink({ name, ssh: name }, model, { sshBin, ...options });
  memberLink.start();
  return { model, link: memberLink };
}

test('a stream is ingested, and stop ends the child', async () => {
  const ssh = fakeSsh(`echo '${HELLO_LINE}'; while :; do echo '${LIVE_LINE()}'; sleep 0.05; done`);
  const { model, link: l } = link('peer', ssh);
  await until('a live frame', () => model.status(Date.now()) === 'live');
  assert.equal(model.hello?.collector, '0.1.0');
  const pid = l.pid()!;
  l.stop();
  await until('the child to exit', () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
});

test('ssh failure is unreachable, not a crash, and it keeps retrying', async () => {
  const counter = join(root, 'attempts');
  const ssh = fakeSsh(`echo x >> '${counter}'; echo 'ssh: connect to host: refused' >&2; exit 255`);
  const { model, link: l } = link('down', ssh);
  await until('three attempts', () => {
    try {
      return readFileSync(counter, 'utf8').length >= 6;
    } catch {
      return false;
    }
  });
  l.stop();
  assert.equal(model.status(Date.now()), 'unreachable');
  assert.equal(model.lostReason(), 'no-link');
});

test('a member without crewtop is reported as such', async () => {
  const { model, link: l } = link('bare', fakeSsh('exit 127'));
  await until('the failure', () => model.lostReason() !== null);
  l.stop();
  assert.equal(model.status(Date.now()), 'unreachable');
  assert.equal(model.lostReason(), 'no-crewtop');
});

test('a missing ssh binary is unreachable, not a crash', async () => {
  const { model, link: l } = link('nossh', join(sshBinDir, 'absent'));
  await until('the failure', () => model.lostReason() !== null);
  l.stop();
  assert.equal(model.status(Date.now()), 'unreachable');
});

test('a frozen collector is cut off by the watchdog, even if a grandchild holds the pipe', async () => {
  const counter = join(root, 'frozen');
  const ssh = fakeSsh(`echo x >> '${counter}'; echo '${HELLO_LINE}'; echo '${LIVE_LINE()}'; sleep 30 & wait`);
  const { model, link: l } = link('frozen', ssh, { ...QUICK, watchdogMs: 100 });
  await until('a second attempt', () => {
    try {
      return readFileSync(counter, 'utf8').length >= 4;
    } catch {
      return false;
    }
  });
  l.stop();
  assert.equal(model.hello?.collector, '0.1.0');
  assert.notEqual(model.status(Date.now()), 'unreachable', 'values from before the freeze are still held');
});

test('a frozen member does not delay another member', async () => {
  const frozen = link('frozen', fakeSsh(`echo '${HELLO_LINE}'; echo '${LIVE_LINE()}'; exec sleep 30`));
  const beat = join(root, 'beat');
  const healthy = link('healthy', fakeSsh(`echo '${HELLO_LINE}'; i=0; while :; do echo '${LIVE_LINE()}'; echo x >> '${beat}'; sleep 0.02; done`));
  await until('both to report', () => frozen.model.status(Date.now()) === 'live' && healthy.model.status(Date.now()) === 'live');
  const seen = readFileSync(beat, 'utf8').length;
  await until('more frames from the healthy member', () => readFileSync(beat, 'utf8').length > seen + 20);
  assert.equal(healthy.model.liveAgeSeconds(Date.now()), 0);
  frozen.link.stop();
  healthy.link.stop();
});

test('non-frame output is counted and dropped', async () => {
  const ssh = fakeSsh(`echo 'Welcome to a noisy login'; echo '{"v":1,"t":"err","code":"ccusage_failed","detail":"x"}'; echo '${HELLO_LINE}'; echo '${LIVE_LINE()}'; exec sleep 30`);
  const { model, link: l } = link('noisy', ssh);
  await until('the live frame', () => model.status(Date.now()) === 'live');
  l.stop();
  assert.equal(model.rejected, 2);
  assert.deepEqual(model.activeErrors(Date.now()), [], 'a rejected frame has no effect');
});

test('a runaway line ends the connection instead of growing without bound', async () => {
  const ssh = fakeSsh(`echo '${HELLO_LINE}'; echo '${LIVE_LINE()}'; while :; do printf '%s' xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done`);
  const { model, link: l } = link('runaway', ssh, { ...QUICK, retryMinMs: 60_000, retryMaxMs: 60_000, maxLineChars: 4096 });
  await until('the connection to drop', () => model.lostReason() !== null);
  l.stop();
  assert.equal(model.status(Date.now()), 'stale');
});

test('a real reconnect holds values through the outage and draws no spike', async () => {
  const attempts = join(root, 'reconnect');
  const usageLine = (ts: number, input: number, cost: number) =>
    `{"v":1,"t":"usage","ts":${ts},"rows":[{"k":"${key(1)}","a":"claude","m":["claude-opus-5-5"],"i":${input},"o":0,"cw":0,"cr":0,"c":${cost}}]}`;
  const ssh = fakeSsh(`
echo x >> '${attempts}'
echo '${HELLO_LINE}'
echo '${LIVE_LINE()}'
if [ "$(wc -l < '${attempts}')" -eq 1 ]; then
  echo '${usageLine(1000, 1000, 1)}'
  echo '${usageLine(1060, 1600, 2)}'
  sleep 0.2
  exit 255
fi
if [ -e '${attempts}.open' ]; then
  echo '${usageLine(2000, 900000, 500)}'
  exec sleep 30
fi
exit 255
`);
  const { model, link: l } = link('peer', ssh, { ...QUICK, retryMinMs: 30, retryMaxMs: 30 });
  await until('the first burn figure', () => model.burn(false).tokensPerMinute === 600);
  await until('the outage', () => model.lostReason() === 'no-link');
  assert.equal(model.status(Date.now()), 'stale');
  assert.equal(model.rows(Date.now(), false).filter((row) => !row.live).length, 1, 'the last usage row is held');
  writeFileSync(`${attempts}.open`, '');
  await until('the catch-up frame', () => model.rows(Date.now(), false).some((row) => row.tokens === 900000));
  assert.equal(model.lostReason(), null);
  assert.equal(model.burn(false).tokensPerMinute, null);
  assert.equal(model.burn(false).costPerHour, null);
  l.stop();
});
