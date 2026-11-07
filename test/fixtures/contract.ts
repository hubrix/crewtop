export const CCUSAGE_PIN = '20.0.48';
export const FIXTURE_DAY = '2026-01-15';

export const CCUSAGE_REPORTS: Record<string, string[]> = {
  session: ['session', '--json', '--offline', '--timezone', 'UTC'],
  daily: ['daily', '--since', FIXTURE_DAY, '--json', '--offline', '--timezone', 'UTC'],
};
