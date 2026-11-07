import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { closedAgentName, isCoveredByCcusage } from '../src/agents.ts';
import { CCUSAGE_CONFIG, CcusageRunner } from '../src/collect/ccusage.ts';
import { parseHerdrList } from '../src/collect/herdr.ts';
import { matchProcessName, mergeLive, scanProcesses } from '../src/collect/proc.ts';
import type { ProcAgent, ProcScan } from '../src/collect/proc.ts';
import { joinId, loadSalt, makeKeyer, sessionKey } from '../src/collect/salt.ts';
import { detectOs, startCollector } from '../src/collect/stream.ts';
import { decodeFrame } from '../src/wire.ts';
import type { Frame, LiveAgent, LiveFrame } from '../src/wire.ts';
import { tempDir, testKeyer, writeScript } from './helpers.ts';

const root = tempDir();
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const freshDir = () => join(root, `case-${++counter}`);

// Closed list

test('closed list: unknown names are refused and aliases resolve', () => {
  assert.equal(closedAgentName('claude'), 'claude');
  assert.equal(closedAgentName('dsh-tui'), 'dsh-tui');
  assert.equal(closedAgentName('agy'), 'antigravity');
  assert.equal(closedAgentName('my project'), null);
  assert.equal(closedAgentName(undefined), null);
  for (const uncovered of ['dsh-tui', 'kiro', 'muse', 'omp']) assert.equal(isCoveredByCcusage(uncovered), false);
  assert.equal(isCoveredByCcusage('claude'), true);
});

// Herdr

test('Herdr: only allowlisted fields survive, and unknowns degrade safely', () => {
  const text = JSON.stringify({
    result: {
      agents: [
        { agent: 'claude', agent_status: 'idle', pane_id: 'w9:p2', agent_session: { value: 'sess-1' }, terminal_title: 'SECRET', cwd: '/SECRET' },
        { agent: 'SECRET-NAME', agent_status: 'SECRET-STATE', pane_id: 'SECRET PANE', agent_session: null },
      ],
    },
  });
  const rows = parseHerdrList(text, testKeyer)!;
  assert.deepEqual(rows[0], { k: sessionKey(testKeyer, 'sess-1'), a: 'claude', st: 'idle', src: 'herdr', seat: 'w9:p2' });
  assert.equal(rows[1]!.a, 'other');
  assert.equal(rows[1]!.st, 'unknown');
  assert.equal(rows[1]!.seat, undefined);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET/);
});

test('Herdr: every status it documents passes through, and a bad shape is refused', () => {
  for (const status of ['idle', 'working', 'blocked', 'done', 'unknown']) {
    const text = JSON.stringify({ result: { agents: [{ agent: 'pi', agent_status: status, pane_id: 'w1:p1' }] } });
    assert.equal(parseHerdrList(text, testKeyer)![0]!.st, status);
  }
  assert.equal(parseHerdrList('nope', testKeyer), null);
  assert.equal(parseHerdrList('{"result":{}}', testKeyer), null);
  assert.deepEqual(parseHerdrList('{"result":{"agents":[]}}', testKeyer), []);
});

// Process table

test('process names: a native binary, a Node CLI, and things that only mention an agent', () => {
  assert.equal(matchProcessName('claude', '/home/u/.local/bin/claude', '--resume'), 'claude');
  assert.equal(matchProcessName('MainThread', 'node', '/opt/app/dsh-tui.js'), 'dsh-tui');
  assert.equal(matchProcessName('node', '/usr/bin/node', '/lib/codex/bin/codex.js'), 'codex');
  assert.equal(matchProcessName('claude', 'node', '/lib/@anthropic-ai/claude-code/cli.js'), 'claude');
  assert.equal(matchProcessName('vim', 'vim', 'claude'), null, 'only an interpreter names a program in argv[1]');
  assert.equal(matchProcessName('grep', 'grep', 'codex'), null);
  assert.equal(matchProcessName('node', 'node', '/opt/my-secret-tool.js'), null);
  assert.equal(matchProcessName('kworker', '', ''), null, 'a kernel thread has no argv');
});

function writeProc(procRoot: string, pid: number, ppid: number, comm: string, argv: string[], startTicks = 1000): void {
  const dir = join(procRoot, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stat'), `${pid} (${comm}) S ${ppid} ${Array(16).fill(0).join(' ')} ${startTicks} 0 0`);
  writeFileSync(join(dir, 'cmdline'), argv.map((a) => `${a}\0`).join(''));
}

test('process scan: same-name helpers collapse, a different agent stays, Herdr ancestry is seen, and argv never surfaces', () => {
  const procRoot = freshDir();
  mkdirSync(procRoot);
  writeFileSync(join(procRoot, 'uptime'), '500.00 100.00\n');
  writeProc(procRoot, 1, 0, 'systemd', ['/sbin/init']);
  writeProc(procRoot, 10, 1, 'herdr', ['/usr/bin/herdr', 'server']);
  writeProc(procRoot, 11, 10, 'bash', ['-bash']);
  writeProc(procRoot, 12, 11, 'claude', ['claude', 'SECRET PROMPT TEXT'], 10_000);
  writeProc(procRoot, 13, 12, 'claude', ['claude', '--child']);
  writeProc(procRoot, 14, 12, 'node', ['node', '/x/codex.js', 'SECRET'], 20_000);
  writeProc(procRoot, 20, 1, 'node', ['node', '/x/codex.js', 'SECRET'], 30_000);
  writeProc(procRoot, 30, 1, 'odd) name (x', ['/bin/cat']);
  writeProc(procRoot, 40, 1, 'kthreadd', []);
  writeFileSync(join(procRoot, 'not-a-pid'), '');
  const scan = scanProcesses(procRoot)!;
  assert.equal(scan.uptimeSeconds, 500);
  assert.deepEqual(scan.agents.map((p) => [p.pid, p.agent, p.underHerdr]).sort(), [
    [12, 'claude', true],
    [14, 'codex', true],
    [20, 'codex', false],
  ]);
  assert.doesNotMatch(JSON.stringify(scan), /SECRET/);
  assert.equal(scanProcesses(join(procRoot, 'missing')), null);
});

const proc = (pid: number, agent: string, underHerdr: boolean, startTicks = 1000): ProcAgent => ({ pid, agent, startTicks, underHerdr });
const herdrRow = (seat: string, a = 'claude'): LiveAgent => ({ k: testKeyer(seat), a, st: 'working', src: 'herdr', seat });
const scanOf = (...agents: ProcAgent[]): ProcScan => ({ agents, uptimeSeconds: 100 });

test('merge: an agent Herdr shows is not counted again from the process table', () => {
  const rows = mergeLive([herdrRow('w1:p1'), herdrRow('w1:p2')], scanOf(proc(1, 'claude', true), proc(2, 'claude', true)), testKeyer);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.src === 'herdr'));
  assert.ok(rows.every((row) => row.up === undefined), 'two candidates, so uptime would be a guess');
});

test('merge: one Herdr row and one process pair up for uptime', () => {
  const [row] = mergeLive([herdrRow('w1:p1')], scanOf(proc(1, 'claude', true, 5000)), testKeyer);
  assert.equal(row!.up, 50);
});

test('merge: a process outside Herdr becomes a proc row with unknown state', () => {
  const rows = mergeLive([herdrRow('w1:p1')], scanOf(proc(1, 'claude', true), proc(2, 'claude', false), proc(3, 'codex', false)), testKeyer);
  assert.equal(rows.length, 3);
  const extra = rows.filter((row) => row.src === 'proc');
  assert.deepEqual(extra.map((row) => [row.a, row.st]).sort(), [['claude', 'unknown'], ['codex', 'unknown']]);
  assert.equal(extra.find((row) => row.a === 'claude')!.k, testKeyer('proc:2:1000'), 'the outside process is the surplus one');
});

test('merge: Herdr alone still works when the scan fails, and Herdr failing leaves the net', () => {
  assert.equal(mergeLive([herdrRow('w1:p1')], null, testKeyer).length, 1);
  const rows = mergeLive(null, scanOf(proc(1, 'claude', true)), testKeyer);
  assert.deepEqual(rows.map((row) => row.src), ['proc']);
});

// Salt

test('salt: created once at mode 0600, tightened if loosened, and stable', () => {
  const path = join(freshDir(), 'nested', 'salt');
  const first = loadSalt(path);
  assert.equal(first.length, 32);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  writeFileSync(path, first, { mode: 0o644 });
  assert.deepEqual(loadSalt(path), first);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('keys: truncated, salted, and joining a rollout path to its UUID', () => {
  const uuid = '33333333-cccc-4ccc-8ccc-333333333333';
  assert.equal(joinId(`2026/01/15/rollout-2026-01-15T11-00-00-${uuid}`), uuid);
  assert.equal(joinId('plain-id'), 'plain-id');
  const a = makeKeyer(Buffer.from('a'));
  const b = makeKeyer(Buffer.from('b'));
  assert.match(sessionKey(a, uuid), /^[0-9a-f]{12}$/);
  assert.notEqual(sessionKey(a, uuid), sessionKey(b, uuid));
});

test('OS detection reads WSL from the kernel string', () => {
  assert.equal(detectOs('linux', '6.6.87.2-microsoft-standard-WSL2'), 'wsl2');
  assert.equal(detectOs('linux', '7.3.0-4-t2-resolute'), 'linux');
  assert.equal(detectOs('darwin', '24.0.0'), 'darwin');
  assert.equal(detectOs('freebsd', '14'), 'unknown');
});

// ccusage calling convention

test('ccusage runs with the exact calling convention, reniced, with stderr closed', async () => {
  const dir = freshDir();
  const record = join(dir, 'record');
  const bin = writeScript(
    dir,
    'ccusage',
    `{ echo "args=$*"; echo "offline=$CCUSAGE_OFFLINE"; echo "nice=$(nice)"; ls -l /proc/$$/fd/2; } > '${record}'
echo '{"session":[]}'
echo 'SECRET-PATH' >&2`,
  );
  const result = await new CcusageRunner({ bin }).run(['session']);
  assert.deepEqual(result.ok && result.stdout.trim(), '{"session":[]}');
  const text = readFileSync(record, 'utf8');
  assert.equal(text.split('\n')[0], `args=session --json --offline --timezone UTC --config ${CCUSAGE_CONFIG}`);
  assert.match(text, /^offline=1$/m);
  assert.match(text, /^nice=(1\d|[2-9]\d)$/m, 'at least nice 10');
  assert.match(text, /\/dev\/null/);
});

test('ccusage gets the shipped empty config, a neutral directory and only the allowlisted environment', async () => {
  assert.deepEqual(JSON.parse(readFileSync(CCUSAGE_CONFIG, 'utf8')), {});
  const dir = freshDir();
  const record = join(dir, 'record');
  const bin = writeScript(dir, 'ccusage', `{ echo "cwd=$(pwd)"; env; } > '${record}'\necho '{}'`);
  const env = { PATH: process.env.PATH, HOME: '/h', XDG_DATA_HOME: '/x', CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/d', GH_TOKEN: 'SECRET-1', ANTHROPIC_API_KEY: 'SECRET-2', CCUSAGE_MODEL_ALIASES: 'SECRET-3', HTTPS_PROXY: 'SECRET-4' };
  const result = await new CcusageRunner({ bin, env }).run(['session']);
  assert.ok(result.ok);
  const text = readFileSync(record, 'utf8');
  assert.match(text, /^cwd=\/$/m);
  for (const line of ['HOME=/h', 'XDG_DATA_HOME=/x', 'CLAUDE_CONFIG_DIR=/c', 'CODEX_HOME=/d']) assert.ok(text.split('\n').includes(line), line);
  assert.doesNotMatch(text, /SECRET/);
});

test('ccusage runs one child at a time', async () => {
  const dir = freshDir();
  const log = join(dir, 'log');
  const bin = writeScript(dir, 'ccusage', `echo start >> '${log}'; sleep 0.2; echo end >> '${log}'; echo '{}'`);
  const runner = new CcusageRunner({ bin });
  await Promise.all([runner.run(['session']), runner.run(['daily'])]);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['start', 'end', 'start', 'end']);
});

test('ccusage timeout kills the whole group and reports a closed code', async () => {
  const dir = freshDir();
  const pidFile = join(dir, 'grandchild');
  const bin = writeScript(dir, 'ccusage', `sleep 60 &\necho $! > '${pidFile}'\nwait`);
  const startedAt = Date.now();
  const result = await new CcusageRunner({ bin, timeoutMs: 300 }).run(['session']);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, 'ccusage_timeout');
  assert.ok(Date.now() - startedAt < 5_000);
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(grandchild, 0), 'the launcher child is gone too');
});

test('ccusage failing or missing reports ccusage_failed', async () => {
  const dir = freshDir();
  const bin = writeScript(dir, 'ccusage', 'echo SECRET >&2; exit 3');
  const failed = await new CcusageRunner({ bin }).run(['session']);
  assert.equal(!failed.ok && failed.code, 'ccusage_failed');
  const missing = await new CcusageRunner({ bin: join(dir, 'absent') }).run(['session']);
  assert.equal(!missing.ok && missing.code, 'ccusage_failed');
});

// The stream loop

async function runCollector(options: { ccusage: string; herdr: string; procRoot?: string }, until: (frames: Frame[]) => boolean): Promise<{ frames: Frame[]; raw: string }> {
  const dir = freshDir();
  const ccusageBin = writeScript(dir, 'ccusage', options.ccusage);
  const herdrBin = writeScript(dir, 'herdr', options.herdr);
  const frames: Frame[] = [];
  let raw = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out; got ${frames.map((f) => f.t).join(',')}`)), 8_000);
    const collector = startCollector({
      keyer: testKeyer,
      ccusageBin,
      herdrBin,
      procRoot: options.procRoot ?? join(dir, 'no-proc'),
      liveIntervalMs: 20,
      todayIntervalMs: 50,
      usageDelayMs: () => 50,
      write: (line) => {
        raw += line;
        const frame = decodeFrame(line);
        assert.ok(frame, 'every written line is a valid frame');
        frames.push(frame);
        if (until(frames)) {
          clearTimeout(timer);
          collector.stop();
          resolve();
        }
      },
    });
  });
  return { frames, raw };
}

const HERDR_OK = `echo '{"result":{"agents":[{"agent":"claude","agent_status":"working","pane_id":"w1:p1"}]}}'`;
const count = (frames: Frame[], t: Frame['t']) => frames.filter((f) => f.t === t).length;

test('stream: garbage from ccusage yields a closed error and no usage frame', async () => {
  const { frames, raw } = await runCollector({ ccusage: 'echo SECRET-GARBAGE', herdr: HERDR_OK }, (f) => f.some((x) => x.t === 'err' && x.code === 'ccusage_bad_output'));
  assert.equal(count(frames, 'usage'), 0, 'no frame means the TUI keeps honest dashes, not zeros');
  assert.equal(frames[0]!.t, 'hello');
  assert.doesNotMatch(raw, /SECRET/);
});

test('stream: ccusage failing keeps liveness flowing', async () => {
  const { frames } = await runCollector({ ccusage: 'exit 1', herdr: HERDR_OK }, (f) => count(f, 'live') >= 3 && count(f, 'err') >= 1);
  assert.ok(frames.some((f) => f.t === 'err' && f.code === 'ccusage_failed'));
});

test('stream: Herdr failing is reported, and the process net still runs', async () => {
  const procRoot = freshDir();
  mkdirSync(procRoot);
  writeFileSync(join(procRoot, 'uptime'), '100.00 1.00\n');
  writeProc(procRoot, 5, 1, 'claude', ['claude', 'SECRET']);
  const { frames, raw } = await runCollector({ ccusage: `echo '{"session":[]}'`, herdr: 'echo SECRET >&2; exit 1', procRoot }, (f) => count(f, 'live') >= 1);
  assert.ok(frames.some((f) => f.t === 'err' && f.code === 'herdr_unavailable'));
  const live = frames.find((f) => f.t === 'live') as LiveFrame;
  assert.deepEqual(live.agents.map((a) => [a.a, a.st, a.src]), [['claude', 'unknown', 'proc']]);
  assert.doesNotMatch(raw, /SECRET/);
});

test('stream: frames refresh on their own cadence', async () => {
  const { frames } = await runCollector(
    { ccusage: `case "$1" in session) echo '{"session":[]}';; *) echo '{"totals":{"inputTokens":1,"outputTokens":2,"cacheCreationTokens":3,"cacheReadTokens":4,"totalCost":0.5}}';; esac`, herdr: HERDR_OK },
    (f) => count(f, 'usage') >= 2 && count(f, 'today') >= 2 && count(f, 'live') >= 3,
  );
  const today = frames.find((f) => f.t === 'today');
  assert.deepEqual(today && today.t === 'today' && [today.i, today.o, today.cw, today.cr, today.c, today.unpriced], [1, 2, 3, 4, 0.5, []]);
});
