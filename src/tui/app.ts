// The terminal shell around the pure view: alternate screen, raw keys, 1 Hz
// repaint of changed lines only, and one link per fleet member.
import { MemberLink } from '../fleet/link.ts';
import type { Member } from '../fleet/config.ts';
import { HostModel } from './model.ts';
import { pageSize, renderScreen } from './render.ts';
import { handleKey, newView, parseKeys, visibleRows } from './view.ts';

const REPAINT_MS = 1_000;
const ENTER_SCREEN = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J';
const LEAVE_SCREEN = '\x1b[?7h\x1b[?25h\x1b[?1049l';

export function runTui(members: Member[]): void {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) {
    process.stderr.write('crewtop needs a terminal. For frames, use: crewtop collect --stream\n');
    process.exitCode = 2;
    return;
  }

  const hosts = members.map((member) => new HostModel(member.name));
  const links = members.map((member, index) => new MemberLink(member, hosts[index]!));
  const view = newView();
  let closing = false;
  let painted: string[] = [];

  const paint = () => {
    const nowMs = Date.now();
    const lines = renderScreen(hosts, view, {
      width: stdout.columns || 80,
      height: stdout.rows || 24,
      nowMs,
      clock: new Date(nowMs).toTimeString().slice(0, 8),
    });
    let out = '';
    lines.forEach((line, index) => {
      if (line !== painted[index]) out += `\x1b[${index + 1};1H${line}\x1b[K`;
    });
    painted = lines;
    if (out) stdout.write(out);
  };

  const close = (exitCode: number) => {
    if (closing) return;
    closing = true;
    for (const link of links) link.stop();
    stdin.setRawMode(false);
    stdout.write(LEAVE_SCREEN);
    process.exit(exitCode);
  };

  stdout.write(ENTER_SCREEN);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.on('data', (data: string) => {
    for (const key of parseKeys(data)) {
      const rows = visibleRows(hosts, view, Date.now());
      handleKey(view, key, rows, pageSize(stdout.rows || 24, hosts.length));
      if (view.quit) close(0);
    }
    paint();
  });
  stdout.on('resize', () => {
    painted = [];
    stdout.write('\x1b[2J');
    paint();
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => close(0));
  process.on('uncaughtException', () => close(1));

  for (const link of links) link.start();
  paint();
  setInterval(paint, REPAINT_MS);
}
