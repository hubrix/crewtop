// Phase 2 exit tests against real members, from this machine. Connects to every
// member in the fleet config through a small local ssh wrapper, then interrupts one
// member's link on this side only: nothing on the member changes.
//
//   node scripts/verify-fleet.ts [--config <path>] [--victim <member>] [--out <dir>]
//
// It freezes the local ssh client (a hung link), then kills it and blocks new
// connections (an outage), then unblocks them. It checks the member greys within
// 10 s with values held, other members are unaffected, and recovery draws no false
// burn spike. Prints screens, which show metrics only.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultFleetConfigPath, loadFleetConfig } from '../src/fleet/config.ts';
import { MemberLink } from '../src/fleet/link.ts';
import { HostModel } from '../src/tui/model.ts';
import { renderScreen } from '../src/tui/render.ts';
import { newView } from '../src/tui/view.ts';

const { values } = parseArgs({ options: { config: { type: 'string' }, victim: { type: 'string' }, out: { type: 'string' } } });
const members = loadFleetConfig(values.config ?? defaultFleetConfigPath())!;
const victim = members.find((member) => member.name === values.victim) ?? members.find((member) => member.ssh !== null);
if (!victim) throw new Error('the config has no ssh member to interrupt');
if (values.out) mkdirSync(values.out, { recursive: true });

const work = mkdtempSync(join(tmpdir(), 'crewtop-verify-'));
const blockFile = join(work, 'block');
const wrapper = join(work, 'ssh');
writeFileSync(wrapper, `#!/bin/sh\n[ -e '${blockFile}' ] && exit 255\nexec ssh "$@"\n`);
chmodSync(wrapper, 0o755);

const hosts = members.map((member) => new HostModel(member.name));
const links = members.map((member, index) => new MemberLink(member, hosts[index]!, { sshBin: wrapper }));
const victimIndex = members.indexOf(victim);
const victimHost = hosts[victimIndex]!;
const victimLink = links[victimIndex]!;
const others = hosts.filter((host) => host !== victimHost);

const stdoutScreen = (name: string, width = 130, height = 26) => {
  const nowMs = Date.now();
  const clock = new Date(nowMs).toISOString().slice(11, 19);
  const raw = renderScreen(hosts, newView(), { width, height, nowMs, clock });
  const text = raw.map((line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd()).join('\n').trimEnd();
  process.stdout.write(`\n--- ${name} (${width} columns)\n${text}\n`);
  if (values.out) {
    writeFileSync(join(values.out, `${name}.txt`), `${text}\n`);
    writeFileSync(join(values.out, `${name}.ansi`), `${raw.join('\n')}\n`);
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what: string, condition: () => boolean, timeoutMs: number): Promise<number> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(100);
  }
  return Date.now() - started;
}

const results: Record<string, unknown> = {};
const checks: [string, boolean][] = [];
const check = (name: string, pass: boolean) => {
  checks.push([name, pass]);
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}\n`);
};
const status = (host: HostModel) => host.status(Date.now());
const othersLive = () => others.filter((host) => status(host) === 'live').length;

let exitCode = 1;
try {
  for (const link of links) link.start();
  // A member may legitimately be down, so wait for whoever can come up.
  await until('the victim to report', () => status(victimHost) === 'live', 30_000);
  await sleep(20_000);
  await until('two usage samples from the victim', () => victimHost.burn(false).tokensPerMinute !== null, 120_000);
  stdoutScreen('1-all-members');
  const liveMembers = hosts.filter((host) => status(host) === 'live').length;
  results.membersLive = `${liveMembers}/${hosts.length}`;
  results.statusByMember = Object.fromEntries(hosts.map((host) => [host.host(), status(host)]));
  check('at least two machines show together', liveMembers >= 2);
  const healthyBefore = othersLive();
  const heldRows = victimHost.rows(Date.now(), false).length;

  process.stdout.write(`\nFreezing the local ssh client for ${victim.name}\n`);
  const pid = victimLink.pid()!;
  process.kill(pid, 'SIGSTOP');
  const greyMs = await until('the frozen member to grey', () => status(victimHost) === 'stale', 15_000);
  results.greyAfterFreezeMs = greyMs;
  check('a hung member greys within 10 s', greyMs <= 10_000);
  check('its last values are held', victimHost.rows(Date.now(), false).length === heldRows && heldRows > 0);
  check('the other members stay live while it hangs', othersLive() === healthyBefore);
  stdoutScreen('2-hung-member-greyed');

  process.stdout.write(`\nKilling that client and blocking reconnects\n`);
  writeFileSync(blockFile, '');
  process.kill(pid, 'SIGKILL');
  await until('the loss to register', () => victimHost.lostReason() === 'no-link', 5_000);
  await sleep(12_000);
  check('it stays grey with values held through the outage', status(victimHost) === 'stale' && victimHost.rows(Date.now(), false).length === heldRows);
  check('the other members stay live through the outage', othersLive() === healthyBefore);
  stdoutScreen('3-outage-held');
  stdoutScreen('3-outage-held-phone', 44, 20);

  process.stdout.write(`\nUnblocking reconnects\n`);
  rmSync(blockFile);
  const recoverMs = await until('the member to recover', () => status(victimHost) === 'live', 60_000);
  results.recoverAfterUnblockMs = recoverMs;
  check('it recovers when it returns', true);
  const firstBurn = victimHost.burn(false);
  results.burnAtRecovery = firstBurn;
  check('no burn figure until two new samples, so no false spike', firstBurn.tokensPerMinute === null && firstBurn.costPerHour === null);
  await until('a usage frame after recovery', () => victimHost.rows(Date.now(), false).some((row) => row.usage !== null), 60_000);
  check('still no burn figure after the catch-up frame', victimHost.burn(false).tokensPerMinute === null);
  stdoutScreen('4-recovered');
  await until('burn to resume', () => victimHost.burn(false).tokensPerMinute !== null, 150_000);
  results.burnAfterRecovery = victimHost.burn(false);
  stdoutScreen('5-burn-resumed');
  exitCode = checks.every(([, pass]) => pass) ? 0 : 1;
} catch (error) {
  process.stdout.write(`FAIL  ${(error as Error).message}\n`);
} finally {
  for (const link of links) link.stop();
  rmSync(work, { recursive: true, force: true });
  process.stdout.write(`\n${JSON.stringify({ pass: exitCode === 0, ...results }, null, 2)}\n`);
  process.exit(exitCode);
}
