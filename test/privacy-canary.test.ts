// The privacy canary. Markers sit in synthetic logs, the Herdr payload, process
// arguments and configuration, then the real collector runs against the real
// pinned ccusage. No marker may reach stdout or stderr. The test also proves it
// can fail: ccusage must have parsed the logs, and at least one marker must be
// present in ccusage's raw JSON, which the collector then has to drop.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { CCUSAGE_BIN } from '../src/collect/ccusage.ts';
import { SAFE_STRING } from '../src/wire.ts';
import type { Frame, HelloFrame, LiveFrame, TodayFrame, UsageFrame } from '../src/wire.ts';
import { CANARIES, SESSION_IDS, writeSyntheticHome } from './fixtures/synthetic-home.ts';
import { captureStream, CREWTOP_BIN, isolatedEnv, tempDir, writeScript } from './helpers.ts';
import type { StreamCapture } from './helpers.ts';

const HERDR_CANARIES = {
  title: 'CANARY_TERMINAL_TITLE_11aa',
  titleStripped: 'CANARY_TITLE_STRIPPED_22bb',
  cwd: 'CANARY_HERDR_CWD_33cc',
  foregroundCwd: 'CANARY_FOREGROUND_CWD_44dd',
  agentName: 'CANARY_AGENT_NAME_55ee',
  status: 'CANARY_STATUS_66ff',
  pane: 'CANARY PANE 77aa',
  sessionValue: 'CANARY_SESSION_VALUE_88bb',
  workspace: 'CANARY_WORKSPACE_99cc',
};
const ARGV_CANARIES = {
  prompt: 'CANARY_ARGV_PROMPT_a1a1',
  directory: 'CANARY_ARGV_DIR_b2b2',
  scriptName: 'CANARY_SCRIPT_NAME_c3c3',
};
const CONFIG_CANARY = 'CANARY_CONFIG_DIR_d4d4';
const SSH_CANARIES = {
  stderr: 'CANARY_SSH_STDERR_e5e5',
  motd: 'CANARY_SSH_MOTD_f6f6',
  smuggledField: 'CANARY_SMUGGLED_FIELD_a7a7',
  smuggledHost: 'CANARY_SMUGGLED_HOST_b8b8',
};
const ENV_CANARY = 'CANARY_ENV_TOKEN_c9c9';
const ALL_MARKERS = [...Object.values(CANARIES), ...Object.values(HERDR_CANARIES), ...Object.values(ARGV_CANARIES), ...Object.values(SSH_CANARIES), CONFIG_CANARY, ENV_CANARY];

const today = new Date().toISOString().slice(0, 10);
const root = tempDir();
const home = join(root, 'home');
const binDir = join(root, 'bin');
const herdrPayload = join(root, 'herdr.json');
const processes: ChildProcess[] = [];

function herdrAgent(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    agent: 'claude',
    agent_status: 'working',
    pane_id: 'w1:p1',
    agent_session: null,
    cwd: `/work/${HERDR_CANARIES.cwd}`,
    foreground_cwd: `/work/${HERDR_CANARIES.foregroundCwd}`,
    terminal_title: HERDR_CANARIES.title,
    terminal_title_stripped: HERDR_CANARIES.titleStripped,
    workspace_id: HERDR_CANARIES.workspace,
    tab_id: HERDR_CANARIES.workspace,
    terminal_id: HERDR_CANARIES.workspace,
    focused: true,
    revision: 1,
    state_change_seq: 1,
    ...fields,
  };
}

function assertNoMarkers(capture: StreamCapture): void {
  for (const marker of ALL_MARKERS) {
    assert.ok(!capture.stdout.includes(marker), `${marker} reached stdout`);
    assert.ok(!capture.stderr.includes(marker), `${marker} reached stderr`);
  }
  assert.doesNotMatch(capture.stdout, /CANARY/);
  assert.doesNotMatch(capture.stderr, /CANARY/);
}

const hasAll = (frames: Frame[]) => ['hello', 'live', 'usage', 'today'].every((t) => frames.some((f) => f.t === t));
const frameOf = <T extends Frame>(frames: Frame[], t: T['t']) => frames.find((f) => f.t === t) as T;

function directoryText(dir: string): string {
  return readdirSync(dir)
    .map((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? name + directoryText(path) : name + readFileSync(path, 'utf8');
    })
    .join('\n');
}

let capture: StreamCapture;

before(async () => {
  writeSyntheticHome(home, { day: today });
  writeFileSync(
    herdrPayload,
    JSON.stringify({
      id: 'cli:agent:list',
      result: {
        type: 'agent_list',
        agents: [
          herdrAgent({ pane_id: 'w1:p1', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: SESSION_IDS.claudeA } }),
          herdrAgent({ pane_id: 'w2:p1', agent: 'dsh-tui', agent_status: 'blocked' }),
          herdrAgent({ pane_id: HERDR_CANARIES.pane, agent: HERDR_CANARIES.agentName, agent_status: HERDR_CANARIES.status, agent_session: { value: HERDR_CANARIES.sessionValue } }),
        ],
      },
    }),
  );
  writeScript(binDir, 'herdr', `cat '${herdrPayload}'`);

  // Real processes that hold markers in their arguments and paths.
  const sleeper = join(root, ARGV_CANARIES.directory);
  mkdirSync(sleeper);
  writeFileSync(join(sleeper, 'codex.js'), 'setInterval(() => {}, 1000);\n');
  copyFileSync(join(sleeper, 'codex.js'), join(sleeper, `${ARGV_CANARIES.scriptName}.js`));
  for (const script of ['codex.js', `${ARGV_CANARIES.scriptName}.js`]) {
    processes.push(spawn(process.execPath, [join(sleeper, script), ARGV_CANARIES.prompt, HERDR_CANARIES.title], { stdio: 'ignore' }));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));

  capture = await captureStream(isolatedEnv(home, binDir), (frames) => hasAll(frames) && frames.filter((f) => f.t === 'live').length >= 2);
});

after(() => {
  for (const child of processes) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

test('the planted markers are really in the source data', () => {
  const logs = directoryText(home);
  for (const marker of Object.values(CANARIES)) assert.ok(logs.includes(marker), marker);
  const herdr = readFileSync(herdrPayload, 'utf8');
  for (const marker of Object.values(HERDR_CANARIES)) assert.ok(herdr.includes(marker), marker);
});

test('ccusage parsed the fixture, and its raw JSON holds a marker to drop', () => {
  const raw = spawnSync(CCUSAGE_BIN, ['session', '--json', '--offline', '--timezone', 'UTC'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, CCUSAGE_OFFLINE: '1' },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).stdout;
  assert.equal(JSON.parse(raw).session.length, 4);
  assert.ok(raw.includes(CANARIES.projectDir), 'the pi row carries projectPath, so a leak is possible');
  assert.ok(raw.includes(CANARIES.model), 'ccusage reports the planted model name, so a leak is possible');
  assert.match(CANARIES.model, SAFE_STRING, 'the wire character set alone would let it through');
  const usage = frameOf<UsageFrame>(capture.frames, 'usage');
  assert.equal(usage.rows.length, 4, 'all sessions came through, so a clean result means something');
});

test('no marker reaches the wire or stderr', () => {
  assert.equal(capture.exitCode, 0, 'closing stdin ends the collector cleanly');
  assertNoMarkers(capture);
});

test('session ids cross the wire only as HMAC keys', () => {
  for (const id of Object.values(SESSION_IDS)) assert.ok(!capture.stdout.includes(id), id);
  assert.ok(!capture.stdout.includes('rollout-'), 'the Codex rollout path stays local');
});

test('the wire carries the numbers and closed-list names, joined by key', () => {
  const live = frameOf<LiveFrame>(capture.frames, 'live');
  const usage = frameOf<UsageFrame>(capture.frames, 'usage');
  const today = frameOf<TodayFrame>(capture.frames, 'today');
  const herdrRows = live.agents.filter((agent) => agent.src === 'herdr');
  assert.deepEqual(herdrRows.map((a) => [a.a, a.st, a.seat ?? null]), [
    ['claude', 'working', 'w1:p1'],
    ['dsh-tui', 'blocked', 'w2:p1'],
    ['other', 'unknown', null],
  ]);
  const claude = herdrRows[0]!;
  const joined = usage.rows.find((row) => row.k === claude.k);
  assert.ok(joined, 'Herdr session id and ccusage session id join through the key');
  assert.deepEqual([joined.i, joined.o, joined.cw, joined.cr], [100, 60, 400, 600]);
  assert.equal(today.i + today.o + today.cw + today.cr, 4780);
  assert.ok(live.agents.some((agent) => agent.a === 'codex' && agent.src === 'proc'), 'the process net sees the agent outside Herdr');
});

test('a model name outside the closed pattern crosses only as other', () => {
  const usage = frameOf<UsageFrame>(capture.frames, 'usage');
  const today = frameOf<TodayFrame>(capture.frames, 'today');
  assert.deepEqual(usage.rows.flatMap((row) => row.m).sort(), ['claude-opus-5-5', 'claude-sonnet-5', 'gpt-5', 'other']);
  assert.deepEqual(today.unpriced, ['other'], 'the unpriced count stays honest');
});

test('the hello frame carries a constant, not the hostname', () => {
  assert.equal(frameOf<HelloFrame>(capture.frames, 'hello').host, 'unnamed-host');
});

test('a ccusage config in the launch directory changes nothing, and secrets stay out of the environment', async () => {
  // Without the protections this config replaces the report with the fake jq's output,
  // which carries a secret from the environment and an invented token count.
  const planted = 424_242;
  const hostile = join(root, 'hostile-repo');
  mkdirSync(join(hostile, '.ccusage'), { recursive: true });
  writeFileSync(join(hostile, '.ccusage', 'ccusage.json'), JSON.stringify({ defaults: { jq: '.' } }));
  const jqBin = join(root, 'jq-bin');
  const jqRan = join(root, 'jq-ran');
  const counts = { inputTokens: planted, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0 };
  const report = JSON.stringify({ session: [{ period: 'x', agent: 'claude', ...counts, modelsUsed: ['@@'], modelBreakdowns: [] }], totals: counts });
  writeScript(jqBin, 'jq', `touch '${jqRan}'\nprintf '%s' '${report}' | sed "s/@@/$GH_TOKEN/"`);
  const env = { ...isolatedEnv(home, binDir), PATH: `${jqBin}:${binDir}:${process.env.PATH}`, GH_TOKEN: ENV_CANARY };
  const result = await captureStream(env, hasAll, 30_000, hostile);
  assertNoMarkers(result);
  assert.ok(!existsSync(jqRan), 'the config never started jq');
  const numbers = (frames: Frame[]) => frameOf<UsageFrame>(frames, 'usage').rows.map((r) => [r.k, r.i, r.o, r.cw, r.cr, r.c]);
  assert.deepEqual(numbers(result.frames), numbers(capture.frames), 'the same sessions, to the number');
  assert.equal(frameOf<TodayFrame>(result.frames, 'today').c, frameOf<TodayFrame>(capture.frames, 'today').c);
});

test('a bad config path that ccusage would echo stays off the wire', async () => {
  const bad = await captureStream(
    isolatedEnv(home, binDir, { CLAUDE_CONFIG_DIR: `/nonexistent/${CONFIG_CANARY}` }),
    (frames) => frames.some((f) => f.t === 'usage' || f.t === 'err'),
  );
  assertNoMarkers(bad);
});

test('the collector exits when the reader of its stdout goes away', async () => {
  const child = spawn(process.execPath, [CREWTOP_BIN, 'collect', '--stream'], { env: isolatedEnv(home, binDir), stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise((resolve) => child.stdout.once('data', resolve));
  child.stdout.destroy();
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('the collector kept running with no reader'));
    }, 10_000);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  assert.equal(code, 0);
  child.stdin.destroy();
});

test('an unwritable salt reports a closed code and exits without leaking the path', async () => {
  const blocker = join(root, CONFIG_CANARY);
  writeFileSync(blocker, '');
  const failed = await captureStream(isolatedEnv(home, binDir, { XDG_STATE_HOME: blocker }), () => false);
  assert.deepEqual(failed.frames, [{ v: 1, t: 'err', code: 'salt_unavailable' }]);
  assert.equal(failed.exitCode, 1);
  assertNoMarkers(failed);
});

/** Runs the real dashboard in a pty until `ready` holds, presses i then q, and returns everything it drew. */
function dashboardOutput(command: string, env: NodeJS.ProcessEnv, ready: (output: string) => boolean): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('script', ['-qfec', `stty cols 130 rows 30; exec ${command}`, '/dev/null'], {
      env: { ...env, TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    let sent = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('the dashboard never showed the expected rows'));
    }, 30_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
      if (!sent && ready(out)) {
        sent = true;
        child.stdin.write('i');
        setTimeout(() => child.stdin.write('q'), 1_200);
      }
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

const HAS_SCRIPT = spawnSync('script', ['--version']).status === 0;

test('over SSH: no marker reaches the screen, and hostile remote output is rejected', { skip: !HAS_SCRIPT }, async () => {
  // The fake ssh is the only thing replaced. Its "peer" runs the real collector on the
  // canary home, behind a noisy login. "hostile" sends frames that break the allowlist.
  // "down" fails the way ssh does, with a path in its stderr.
  const sshBin = join(root, 'ssh-bin');
  const argsFile = join(root, 'ssh-args');
  writeScript(sshBin, 'ssh', `
for target; do :; done
printf '%s\\n' "$*" >> '${argsFile}'
echo '${SSH_CANARIES.stderr} /home/x/.ssh/id_ed25519: permission denied' >&2
case "$*" in
  *' -- down '*) exit 255 ;;
  *' -- hostile '*)
    echo '{"v":1,"t":"err","code":"ccusage_failed","detail":"${SSH_CANARIES.smuggledField}"}'
    echo '{"v":1,"t":"hello","host":"${SSH_CANARIES.smuggledHost} /home/x","os":"linux","collector":"0","ccusage":"0"}'
    exec cat ;;
esac
echo '${SSH_CANARIES.motd}: welcome to the machine'
exec '${process.execPath}' '${CREWTOP_BIN}' collect --stream
`);
  const config = join(root, 'fleet.toml');
  writeFileSync(config, ['[[member]]', 'name = "hub-box"', 'local = true', '[[member]]', 'name = "peer-box"', 'ssh = "peer"', '[[member]]', 'name = "down-box"', 'ssh = "down"', '[[member]]', 'name = "hostile-box"', 'ssh = "hostile"'].join('\n'));
  const env = { ...isolatedEnv(home, binDir), PATH: `${sshBin}:${binDir}:${process.env.PATH}` };
  const screen = await dashboardOutput(`'${CREWTOP_BIN}' --fleet '${config}'`, env, (out) => /2\/4 /.test(out) && out.includes('1.2k') && out.includes('peer-box') && out.includes('n/a'));
  assert.doesNotMatch(screen, /CANARY/);
  assert.doesNotMatch(screen, /id_ed25519|\/home\/x/, 'ssh stderr never reaches the screen');
  assert.match(screen, /peer-box/);
  assert.match(screen, /dsh-tui/, 'real collector rows arrived over the remote path');
  assert.match(screen, /down-box[^\n]*unreachable/);
  assert.match(screen, /hostile-box[^\n]*update needed/);
  assert.match(screen, /rejected \d+ frames/);
  const args = readFileSync(argsFile, 'utf8');
  assert.doesNotMatch(args, /CANARY/);
  assert.match(args, /-- peer crewtop collect --stream/, 'only the fixed collector command runs on a member');
});

test('the dashboard screen shows metrics only', { skip: !HAS_SCRIPT }, async () => {
  // A joined claude row and the n/a row mean live and usage frames both arrived.
  const screen = await dashboardOutput(`'${CREWTOP_BIN}'`, isolatedEnv(home, binDir), (out) => out.includes('n/a') && out.includes('1.2k'));
  assert.doesNotMatch(screen, /CANARY/);
  assert.match(screen, /dsh-tui/);
  assert.ok(screen.includes('\x1b[?1049h'), 'uses the alternate screen');
  assert.ok(screen.includes('\x1b[?1049l'), 'restores the terminal');
});
