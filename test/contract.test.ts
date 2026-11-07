// The ccusage JSON contract: the pinned version, run on synthetic logs, must still
// produce the recorded fixture, and crewtop must read that fixture to the exact number.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CCUSAGE_AGENTS } from '../src/agents.ts';
import { CCUSAGE_BIN, CCUSAGE_ENV_VARS, CcusageRunner, ccusageVersion, PACKAGE_ROOT, parseDailyReport, parseSessionReport, usageDelaySeconds } from '../src/collect/ccusage.ts';
import { sessionKey } from '../src/collect/salt.ts';
import { CCUSAGE_PIN, CCUSAGE_REPORTS, FIXTURE_DAY } from './fixtures/contract.ts';
import { SESSION_IDS, writeSyntheticHome } from './fixtures/synthetic-home.ts';
import { tempDir, testKeyer } from './helpers.ts';

const fixture = (name: string) => readFileSync(join(PACKAGE_ROOT, 'test', 'fixtures', 'ccusage', `${name}.json`), 'utf8');

const home = tempDir();
writeSyntheticHome(home, { day: FIXTURE_DAY });
after(() => rmSync(home, { recursive: true, force: true }));

const NATIVE_BIN = join(PACKAGE_ROOT, 'node_modules', '@ccusage', `ccusage-${process.platform}-${process.arch}`, 'bin', 'ccusage');

function runPinned(args: string[]): string {
  const result = spawnSync(CCUSAGE_BIN, args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, CCUSAGE_OFFLINE: '1' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.equal(result.status, 0);
  return result.stdout;
}

test('ccusage is pinned to an exact version everywhere', () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.dependencies.ccusage, CCUSAGE_PIN);
  assert.deepEqual(Object.keys(pkg.dependencies), ['ccusage'], 'ccusage is the only runtime dependency');
  assert.equal(lock.packages['node_modules/ccusage'].version, CCUSAGE_PIN);
  assert.equal(ccusageVersion(), CCUSAGE_PIN);
  for (const variant of ['linux-x64', 'darwin-arm64', 'darwin-x64']) {
    assert.ok(lock.packages[`node_modules/@ccusage/ccusage-${variant}`], `lockfile records ${variant}`);
  }
});

for (const [name, args] of Object.entries(CCUSAGE_REPORTS)) {
  test(`pinned ccusage still produces the recorded ${name} fixture`, () => {
    assert.deepEqual(JSON.parse(runPinned(args)), JSON.parse(fixture(name)));
  });
}

async function runReal(report: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await new CcusageRunner({ env }).run(report);
  assert.ok(result.ok, 'ccusage ran');
  return result.stdout;
}

test('the empty config and the allowlisted environment still produce both fixtures', async () => {
  const env = { PATH: process.env.PATH, HOME: home };
  assert.deepEqual(JSON.parse(await runReal(['session'], env)), JSON.parse(fixture('session')));
  assert.deepEqual(JSON.parse(await runReal(['daily', '--since', FIXTURE_DAY], env)), JSON.parse(fixture('daily')));
});

test('the agent directory variables on the allowlist move the logs', async () => {
  const emptyHome = tempDir();
  after(() => rmSync(emptyHome, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    HOME: emptyHome,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    PI_AGENT_DIR: join(home, '.pi', 'agent'),
  };
  const rows = parseSessionReport(await runReal(['session'], env), testKeyer)!;
  assert.deepEqual(rows.map((row) => [row.k, row.i, row.o, row.cw, row.cr]), parseSessionReport(fixture('session'), testKeyer)!.map((row) => [row.k, row.i, row.o, row.cw, row.cr]));
});

test('the environment allowlist matches the variables in the ccusage binary', { skip: !existsSync(NATIVE_BIN) }, () => {
  let text = readFileSync(NATIVE_BIN, 'latin1');
  for (const name of CCUSAGE_ENV_VARS) assert.ok(text.includes(name), `${name} is no longer read by ccusage`);
  for (const name of CCUSAGE_ENV_VARS) if (name.includes('_')) text = text.split(name).join(' ');
  const unlisted = text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:HOME|DIR|ROOT)\b/g) ?? [];
  assert.deepEqual([...new Set(unlisted)], [], 'a new directory variable belongs on the allowlist, or its adapter loses its logs');
});

test('every agent on the covered list is a ccusage subcommand', () => {
  const help = spawnSync(CCUSAGE_BIN, ['--help'], { encoding: 'utf8' }).stdout;
  for (const agent of CCUSAGE_AGENTS) {
    assert.match(help, new RegExp(`^\\s+${agent}\\s`, 'm'), agent);
  }
});

test('session rows equal the fixture number for number', () => {
  const raw = JSON.parse(fixture('session')) as { session: Record<string, any>[]; totals: Record<string, number> };
  const rows = parseSessionReport(fixture('session'), testKeyer);
  assert.ok(rows);
  assert.equal(rows.length, 4);
  raw.session.forEach((source, index) => {
    const row = rows[index]!;
    assert.equal(row.i, source.inputTokens);
    assert.equal(row.o, source.outputTokens);
    assert.equal(row.cw, source.cacheCreationTokens);
    assert.equal(row.cr, source.cacheReadTokens);
    assert.equal(row.i + row.o + row.cw + row.cr, source.totalTokens);
    assert.equal(row.a, source.agent);
    assert.equal(row.k, sessionKey(testKeyer, source.period));
  });
  assert.equal(rows.reduce((total, row) => total + row.i + row.o + row.cw + row.cr, 0), raw.totals.totalTokens);
});

test('a Codex rollout path reduces to the UUID that joins with Herdr', () => {
  const rows = parseSessionReport(fixture('session'), testKeyer)!;
  const codex = rows.find((row) => row.a === 'codex')!;
  assert.equal(codex.k, sessionKey(testKeyer, SESSION_IDS.codex));
});

test('a model without a price has no cost, rather than a cost of zero', () => {
  const rows = parseSessionReport(fixture('session'), testKeyer)!;
  const unpriced = rows.find((row) => row.k === sessionKey(testKeyer, SESSION_IDS.claudeB))!;
  assert.equal(unpriced.c, undefined);
  assert.deepEqual(unpriced.m, ['other'], 'an unlisted name crosses as a fixed word');
  const priced = rows.find((row) => row.k === sessionKey(testKeyer, SESSION_IDS.pi))!;
  assert.equal(priced.c, 0.25);
  assert.deepEqual(priced.m, ['claude-sonnet-5'], 'the [pi] prefix is removed');
});

test('daily totals are read exactly, and unpriced models are listed', () => {
  const raw = JSON.parse(fixture('daily')).totals;
  assert.deepEqual(parseDailyReport(fixture('daily')), {
    i: raw.inputTokens,
    o: raw.outputTokens,
    cw: raw.cacheCreationTokens,
    cr: raw.cacheReadTokens,
    c: raw.totalCost,
    unpriced: ['other'],
  });
});

const FAKE_SESSION = { period: 'x', agent: 'claude', inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0 };
const OUTSIDE_THE_PATTERN = [
  'CANARY-MODEL-acme-private-proj:v2',
  'acme-private-proj:v2',
  'sk-ant-api03-CANARYFAKETOKEN0000000000',
  'ghp_CANARYFAKEGITHUBTOKEN00000000000000',
  'box-a.example.com',
  '/home/x/CANARY-MODEL-PATH',
  'CANARY MODEL WITH SPACE',
  'Claude-Opus-5-5',
  'claudeacme',
  'claude-' + 'x'.repeat(40),
  '',
  'other-thing',
  'defaults',
  7,
  null,
];

test('a model name outside the closed pattern is reported as other', () => {
  const rows = parseSessionReport(JSON.stringify({ session: [{ ...FAKE_SESSION, modelsUsed: OUTSIDE_THE_PATTERN }] }), testKeyer)!;
  assert.deepEqual(rows[0]!.m, OUTSIDE_THE_PATTERN.map(() => 'other'));
  const totals = { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0, unpricedModels: OUTSIDE_THE_PATTERN };
  assert.deepEqual(parseDailyReport(JSON.stringify({ totals }))!.unpriced, OUTSIDE_THE_PATTERN.map(() => 'other'), 'one for each, so the count stays honest');
});

test('known model families and the literal default pass through', () => {
  const names = ['default', 'claude-opus-4-8', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-3-5-sonnet-20241022', 'gpt-5', 'gpt-5.1-codex-max', 'o3', 'o4-mini', 'gemini-2.5-pro', 'grok-4', 'kimi-k2', 'qwen3-coder-plus', 'glm-4.6', 'deepseek-chat'];
  const rows = parseSessionReport(JSON.stringify({ session: [{ ...FAKE_SESSION, modelsUsed: names }] }), testKeyer)!;
  assert.deepEqual(rows[0]!.m, names);
});

test('output that breaks the contract is refused, not read as zero', () => {
  assert.equal(parseSessionReport('not json', testKeyer), null);
  assert.equal(parseSessionReport('{"sessions":[]}', testKeyer), null);
  const drifted = JSON.stringify({ session: [{ period: 'x', agent: 'claude', inputTokens: '12', outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0 }] });
  assert.equal(parseSessionReport(drifted, testKeyer), null);
  assert.equal(parseDailyReport('{"totals":{}}'), null);
  assert.deepEqual(parseSessionReport('{"session":[]}', testKeyer), []);
});

test('the usage delay adapts between 15 s and 120 s', () => {
  assert.equal(usageDelaySeconds(0.9), 15);
  assert.equal(usageDelaySeconds(9.2), 92);
  assert.equal(usageDelaySeconds(60), 120);
});

test('the installed launcher exists at the documented path', () => {
  assert.ok(existsSync(CCUSAGE_BIN));
});
