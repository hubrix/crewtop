// Re-records the ccusage JSON contract fixture from the pinned version, using
// synthetic logs only. Run after a deliberate ccusage bump: npm run record-fixture
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CCUSAGE_BIN, PACKAGE_ROOT } from '../src/collect/ccusage.ts';
import { writeSyntheticHome } from '../test/fixtures/synthetic-home.ts';
import { CCUSAGE_REPORTS, FIXTURE_DAY } from '../test/fixtures/contract.ts';

const home = mkdtempSync(join(tmpdir(), 'crewtop-fixture-'));
try {
  writeSyntheticHome(home, { day: FIXTURE_DAY });
  for (const [name, args] of Object.entries(CCUSAGE_REPORTS)) {
    const result = spawnSync(CCUSAGE_BIN, args, {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home, CCUSAGE_OFFLINE: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) throw new Error(`ccusage ${name} exited ${result.status}`);
    writeFileSync(join(PACKAGE_ROOT, 'test', 'fixtures', 'ccusage', `${name}.json`), result.stdout);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
