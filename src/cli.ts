import { collectorVersion } from './collect/ccusage.ts';
import { runCollectStream } from './collect/stream.ts';
import { defaultFleetConfigPath, FleetConfigError, loadFleetConfig, LOCAL_ONLY } from './fleet/config.ts';
import type { Member } from './fleet/config.ts';

const USAGE = `crewtop: htop for agents running and tokens burned

  crewtop                   Open the dashboard for every member in the fleet config,
                            or for this machine alone if there is no config
  crewtop --local           Open the dashboard for this machine alone
  crewtop --fleet <path>    Open the dashboard for the members in <path>
  crewtop collect --stream  Emit wire protocol v1 frames on stdout until stdin closes
  crewtop --version         Print the version

Fleet config: ${defaultFleetConfigPath()}
`;

/** Reads the members, or returns null after reporting a bad config. */
function members(path: string, missingIsOk: boolean): Member[] | null {
  try {
    return loadFleetConfig(path, missingIsOk) ?? LOCAL_ONLY;
  } catch (error) {
    if (!(error instanceof FleetConfigError)) throw error;
    process.stderr.write(`crewtop: ${path}: ${error.message}\n`);
    process.exitCode = 2;
    return null;
  }
}

async function openDashboard(list: Member[] | null): Promise<void> {
  if (!list) return;
  const { runTui } = await import('./tui/app.ts');
  runTui(list);
}

const args = process.argv.slice(2);

if (args.length === 0) {
  await openDashboard(members(defaultFleetConfigPath(), true));
} else if (args[0] === '--local' && args.length === 1) {
  await openDashboard(LOCAL_ONLY);
} else if (args[0] === '--fleet' && args.length === 2) {
  await openDashboard(members(args[1]!, false));
} else if (args[0] === 'collect' && args[1] === '--stream' && args.length === 2) {
  runCollectStream();
} else if (args[0] === '--version') {
  process.stdout.write(`crewtop ${collectorVersion()}\n`);
} else if (args[0] === '--help' || args[0] === '-h') {
  process.stdout.write(USAGE);
} else {
  process.stderr.write(USAGE);
  process.exitCode = 2;
}
