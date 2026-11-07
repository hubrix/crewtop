// Phase 1 exit test on the machine it runs on. Compares what `crewtop collect
// --stream` says with `ccusage session --json` and `herdr agent list` read
// moments later. Active sessions move between the two reads, so each comparison
// retries on later frames. Prints counts, seats and enums only.
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { closedAgentName, OTHER_AGENT } from '../src/agents.ts';
import { CCUSAGE_BIN, PACKAGE_ROOT } from '../src/collect/ccusage.ts';
import { loadSalt, makeKeyer, sessionKey } from '../src/collect/salt.ts';
import { decodeFrame, STATES } from '../src/wire.ts';
import type { LiveFrame, State, UsageFrame } from '../src/wire.ts';

const MAX_USAGE_ROUNDS = 8;
const MAX_LIVE_ROUNDS = 30;

const keyer = makeKeyer(loadSalt());

function compareUsage(frame: UsageFrame) {
  const result = spawnSync(CCUSAGE_BIN, ['session', '--json', '--offline', '--timezone', 'UTC'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, CCUSAGE_OFFLINE: '1' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const source = (JSON.parse(result.stdout) as { session: Record<string, any>[] }).session;
  const rows = new Map(frame.rows.map((row) => [row.k, row]));
  let exact = 0;
  let differ = 0;
  let missing = 0;
  let sourceTokens = 0;
  let wireTokens = 0;
  for (const raw of source) {
    const row = rows.get(sessionKey(keyer, raw.period));
    sourceTokens += raw.totalTokens;
    if (!row) {
      missing++;
      continue;
    }
    wireTokens += row.i + row.o + row.cw + row.cr;
    const same = row.i === raw.inputTokens && row.o === raw.outputTokens && row.cw === raw.cacheCreationTokens && row.cr === raw.cacheReadTokens && row.i + row.o + row.cw + row.cr === raw.totalTokens && (row.c === undefined || row.c === raw.totalCost);
    if (same) exact++;
    else differ++;
  }
  return { sessions: source.length, wireRows: frame.rows.length, exact, differ, missing, sourceTokens, wireTokens };
}

function compareLive(frame: LiveFrame) {
  const result = spawnSync('herdr', ['agent', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const source = (JSON.parse(result.stdout) as { result: { agents: Record<string, any>[] } }).result.agents;
  const wire = frame.agents.filter((agent) => agent.src === 'herdr');
  const table = source.map((raw) => {
    const row = wire.find((agent) => agent.seat === raw.pane_id);
    const expected = STATES.includes(raw.agent_status as State) ? raw.agent_status : 'unknown';
    return {
      seat: raw.pane_id as string,
      herdrState: expected as string,
      wireState: row?.st ?? 'absent',
      wireAgent: row?.a ?? 'absent',
      agree: row?.st === expected && row?.a === (closedAgentName(raw.agent) ?? OTHER_AGENT),
    };
  });
  return { herdrRows: source.length, wireHerdrRows: wire.length, procRows: frame.agents.length - wire.length, table, agree: wire.length === source.length && table.every((row) => row.agree) };
}

const child = spawn(process.execPath, [join(PACKAGE_ROOT, 'bin', 'crewtop'), 'collect', '--stream'], { stdio: ['pipe', 'pipe', 'ignore'] });
let usageRounds = 0;
let liveRounds = 0;
let usageResult: ReturnType<typeof compareUsage> | null = null;
let liveResult: ReturnType<typeof compareLive> | null = null;
let joined = 0;
let latestUsage: UsageFrame | null = null;

const usageOk = () => usageResult !== null && usageResult.differ === 0 && usageResult.missing === 0 && usageResult.exact === usageResult.sessions && usageResult.wireRows === usageResult.sessions;
const usageDone = () => usageOk() || usageRounds >= MAX_USAGE_ROUNDS;
const liveDone = () => liveResult?.agree === true || liveRounds >= MAX_LIVE_ROUNDS;

function finish(): void {
  const pass = usageOk() && liveResult?.agree === true;
  process.stdout.write(`${JSON.stringify({ pass, usageRounds, liveRounds, usage: usageResult, live: liveResult, herdrRowsJoinedToUsage: joined }, null, 2)}\n`);
  child.stdin.end();
  process.exitCode = pass ? 0 : 1;
}

createInterface({ input: child.stdout }).on('line', (line) => {
  const frame = decodeFrame(line);
  if (!frame) throw new Error('the collector wrote an invalid frame');
  if (frame.t === 'usage') {
    latestUsage = frame;
    if (!usageDone()) {
      usageRounds++;
      usageResult = compareUsage(frame);
    }
  }
  if (frame.t === 'live' && latestUsage && !liveDone()) {
    liveRounds++;
    liveResult = compareLive(frame);
    const keys = new Set(latestUsage.rows.map((row) => row.k));
    joined = frame.agents.filter((agent) => keys.has(agent.k)).length;
  }
  if (usageResult && liveResult && usageDone() && liveDone()) finish();
});
