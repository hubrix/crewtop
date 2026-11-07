// Builds a throwaway HOME holding synthetic agent logs. Every value here is
// invented. Each CANARY marker sits in a place a real log keeps free text, so a
// leak through ccusage or the collector shows up as a marker in wire output.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CANARIES = {
  prompt: 'CANARY_PROMPT_7f3a',
  response: 'CANARY_RESPONSE_19bc',
  thinking: 'CANARY_THINKING_52de',
  toolCommand: 'CANARY_TOOL_COMMAND_a804',
  toolResult: 'CANARY_TOOL_RESULT_6c11',
  cwd: 'CANARY_CWD_d9e2',
  branch: 'CANARY_BRANCH_40fa',
  aiTitle: 'CANARY_AI_TITLE_77b3',
  lastPrompt: 'CANARY_LAST_PROMPT_e15c',
  projectDir: 'CANARY_PROJECT_DIR_2b6d',
  corrupted: 'CANARY_CORRUPTED_LINE_c390',
  // Fits the wire's character set, so only the closed model pattern can stop it.
  model: 'CANARY_MODEL_3e8a',
} as const;

export const SESSION_IDS = {
  claudeA: '11111111-aaaa-4aaa-8aaa-111111111111',
  claudeB: '22222222-bbbb-4bbb-8bbb-222222222222',
  codex: '33333333-cccc-4ccc-8ccc-333333333333',
  pi: '44444444-dddd-4ddd-8ddd-444444444444',
} as const;

const c = CANARIES;

function jsonl(path: string, records: unknown[], trailer = ''): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n' + trailer);
}

function claudeLog(sessionId: string, day: string, model: string, n: number): unknown[] {
  const at = (s: number) => `${day}T10:00:${String(s).padStart(2, '0')}.000Z`;
  const base = { sessionId, cwd: `/work/${c.cwd}`, gitBranch: c.branch, version: '9.9.9' };
  return [
    { type: 'user', uuid: `${sessionId}-u1`, timestamp: at(0), ...base, message: { role: 'user', content: c.prompt } },
    {
      type: 'assistant',
      uuid: `${sessionId}-a1`,
      parentUuid: `${sessionId}-u1`,
      requestId: `req-${sessionId}-1`,
      timestamp: at(1),
      ...base,
      message: {
        id: `msg-${sessionId}-1`,
        role: 'assistant',
        model,
        content: [
          { type: 'thinking', thinking: c.thinking },
          { type: 'text', text: c.response },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: c.toolCommand } },
        ],
        usage: { input_tokens: 100 * n, output_tokens: 60 * n, cache_creation_input_tokens: 400 * n, cache_read_input_tokens: 600 * n },
      },
    },
    {
      type: 'user',
      uuid: `${sessionId}-u2`,
      timestamp: at(2),
      ...base,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: c.toolResult }] },
    },
    { type: 'ai-title', sessionId, aiTitle: c.aiTitle },
    { type: 'last-prompt', sessionId, lastPrompt: c.lastPrompt },
  ];
}

export interface SyntheticOptions {
  /** YYYY-MM-DD for every record. */
  day: string;
}

export function writeSyntheticHome(home: string, { day }: SyntheticOptions): void {
  const projects = join(home, '.claude', 'projects', `-work-${c.projectDir}`);
  jsonl(join(projects, `${SESSION_IDS.claudeA}.jsonl`), claudeLog(SESSION_IDS.claudeA, day, 'claude-opus-5-5', 1), `{"type":"user","message":"${c.corrupted}\n`);
  // An invented model name has no price, so ccusage flags it instead of costing it.
  jsonl(join(projects, `${SESSION_IDS.claudeB}.jsonl`), claudeLog(SESSION_IDS.claudeB, day, c.model, 2));

  const codexAt = `${day}T11:00:00.000Z`;
  const codexUsage = { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 1200 };
  jsonl(join(home, '.codex', 'sessions', ...day.split('-'), `rollout-${day}T11-00-00-${SESSION_IDS.codex}.jsonl`), [
    { timestamp: codexAt, type: 'session_meta', payload: { id: SESSION_IDS.codex, cwd: `/work/${c.cwd}`, instructions: c.prompt, git: { branch: c.branch } } },
    { timestamp: codexAt, type: 'turn_context', payload: { model: 'gpt-5', cwd: `/work/${c.cwd}` } },
    { timestamp: codexAt, type: 'event_msg', payload: { type: 'user_message', message: c.prompt } },
    { timestamp: codexAt, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: c.response }] } },
    { timestamp: codexAt, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: codexUsage, last_token_usage: codexUsage, model_context_window: 1000000 } } },
  ]);

  const piAt = `${day}T12:00:00.000Z`;
  jsonl(join(home, '.pi', 'agent', 'sessions', `--work-${c.projectDir}--`, `${day}T12-00-00-000Z_${SESSION_IDS.pi}.jsonl`), [
    { type: 'session', version: 3, id: SESSION_IDS.pi, timestamp: piAt, cwd: `/work/${c.cwd}` },
    { type: 'message', id: 'p1', parentId: null, timestamp: piAt, message: { role: 'user', content: c.prompt } },
    {
      type: 'message',
      id: 'p2',
      parentId: 'p1',
      timestamp: piAt,
      message: {
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: c.response }],
        usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100, cost: { total: 0.25 } },
      },
    },
  ]);
}
