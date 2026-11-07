// View state and key handling. Pure, so behaviour is testable without a terminal.
import { matchesText, sortRows, SORT_MODES } from './model.ts';
import type { HostModel, Row, SortMode } from './model.ts';

export interface View {
  selected: string | null;
  scroll: number;
  showEnded: boolean;
  withCache: boolean;
  sort: SortMode;
  /** Keeps each member's rows together, in config order. Off sorts across the whole fleet. */
  grouped: boolean;
  filter: string;
  prompt: { kind: 'find' | 'filter'; text: string } | null;
  overlay: 'help' | 'detail' | null;
  quit: boolean;
}

export function newView(): View {
  return { selected: null, scroll: 0, showEnded: false, withCache: false, sort: '$/h', grouped: true, filter: '', prompt: null, overlay: null, quit: false };
}

/** The rows the table shows, after the `i` toggle, the filter, the grouping and the sort. */
export function visibleRows(hosts: HostModel[], view: View, nowMs: number): Row[] {
  const liveFilter = view.prompt?.kind === 'filter' ? view.prompt.text : view.filter;
  const shown = (host: HostModel) =>
    host
      .rows(nowMs, view.withCache)
      .filter((row) => (view.showEnded || row.live) && (liveFilter === '' || matchesText(row, liveFilter)));
  if (view.grouped) return hosts.flatMap((host) => sortRows(shown(host), view.sort));
  return sortRows(hosts.flatMap(shown), view.sort);
}

export function selectedIndex(rows: Row[], view: View): number {
  const index = rows.findIndex((row) => row.id === view.selected);
  return index === -1 ? 0 : index;
}

/** Keeps the selection on a real row and inside the visible page. */
export function settle(view: View, rows: Row[], pageSize: number): void {
  const index = selectedIndex(rows, view);
  view.selected = rows[index]?.id ?? null;
  const page = Math.max(1, pageSize);
  if (index < view.scroll) view.scroll = index;
  if (index >= view.scroll + page) view.scroll = index - page + 1;
  view.scroll = Math.max(0, Math.min(view.scroll, Math.max(0, rows.length - page)));
}

function move(view: View, rows: Row[], delta: number): void {
  if (rows.length === 0) return;
  const index = Math.max(0, Math.min(rows.length - 1, selectedIndex(rows, view) + delta));
  view.selected = rows[index]!.id;
}

function jumpToMatch(view: View, rows: Row[], text: string): void {
  if (text === '') return;
  const start = selectedIndex(rows, view);
  for (let offset = 0; offset < rows.length; offset++) {
    const row = rows[(start + offset) % rows.length]!;
    if (matchesText(row, text)) {
      view.selected = row.id;
      return;
    }
  }
}

function handlePromptKey(view: View, key: string, rows: Row[]): void {
  const prompt = view.prompt!;
  if (key === 'escape') {
    view.prompt = null;
  } else if (key === 'enter') {
    if (prompt.kind === 'filter') view.filter = prompt.text;
    else jumpToMatch(view, rows, prompt.text);
    view.prompt = null;
  } else if (key === 'backspace') {
    prompt.text = prompt.text.slice(0, -1);
  } else if (key.length === 1 && key >= ' ' && key <= '~') {
    prompt.text += key;
  }
}

export function handleKey(view: View, key: string, rows: Row[], pageSize: number): void {
  if (key === 'ctrl-c') {
    view.quit = true;
    return;
  }
  if (view.prompt) {
    handlePromptKey(view, key, rows);
    return;
  }
  if (view.overlay) {
    if (key === 'q') view.quit = true;
    view.overlay = null;
    return;
  }
  switch (key) {
    case 'q':
      view.quit = true;
      break;
    case 'up':
      move(view, rows, -1);
      break;
    case 'down':
      move(view, rows, 1);
      break;
    case 'pageup':
      move(view, rows, -pageSize);
      break;
    case 'pagedown':
      move(view, rows, pageSize);
      break;
    case 'home':
      move(view, rows, -rows.length);
      break;
    case 'end':
      move(view, rows, rows.length);
      break;
    case 'f1':
    case 'h':
    case '?':
      view.overlay = 'help';
      break;
    case 'f3':
    case '/':
      view.prompt = { kind: 'find', text: '' };
      break;
    case 'f4':
    case 'f':
      view.prompt = { kind: 'filter', text: view.filter };
      break;
    case 'f5':
    case 'g':
      view.grouped = !view.grouped;
      break;
    case 'f6':
    case 's':
      view.sort = SORT_MODES[(SORT_MODES.indexOf(view.sort) + 1) % SORT_MODES.length]!;
      break;
    case 'i':
      view.showEnded = !view.showEnded;
      break;
    case 'c':
      view.withCache = !view.withCache;
      break;
    case 'enter':
      if (rows.length > 0) view.overlay = 'detail';
      break;
  }
}

const SEQUENCES: Record<string, string> = {
  '\x1b[A': 'up',
  '\x1bOA': 'up',
  '\x1b[B': 'down',
  '\x1bOB': 'down',
  '\x1b[5~': 'pageup',
  '\x1b[6~': 'pagedown',
  '\x1b[H': 'home',
  '\x1bOH': 'home',
  '\x1b[1~': 'home',
  '\x1b[F': 'end',
  '\x1bOF': 'end',
  '\x1b[4~': 'end',
  '\x1bOP': 'f1',
  '\x1b[11~': 'f1',
  '\x1bOR': 'f3',
  '\x1b[13~': 'f3',
  '\x1bOS': 'f4',
  '\x1b[14~': 'f4',
  '\x1b[15~': 'f5',
  '\x1b[17~': 'f6',
  '\x1b': 'escape',
  '\r': 'enter',
  '\n': 'enter',
  '\x7f': 'backspace',
  '\b': 'backspace',
  '\x03': 'ctrl-c',
};

/** Splits a chunk of terminal input into key names. Unknown sequences become ''. */
export function parseKeys(data: string): string[] {
  const tokens = data.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Z]|[\s\S]/g) ?? [];
  return tokens.map((token) => SEQUENCES[token] ?? (token.startsWith('\x1b') ? '' : token));
}
