import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, encodeFrame, validateFrame } from '../src/wire.ts';
import type { Frame } from '../src/wire.ts';

const REPORT_EXAMPLES = [
  '{"v":1,"t":"hello","host":"unnamed-host","os":"wsl2","collector":"0.1.0","ccusage":"20.0.48"}',
  '{"v":1,"t":"live","ts":1793940923,"agents":[{"k":"a1b2c3d4e5f6","a":"claude","st":"working","src":"herdr","seat":"w9:p2","up":205}]}',
  '{"v":1,"t":"usage","ts":1793940923,"rows":[{"k":"a1b2c3d4e5f6","a":"claude","m":["claude-opus-5-5"],"i":361,"o":182553,"cw":1404353,"cr":31500339,"c":34.07,"la":"2026-11-06T04:51:11Z"}]}',
  '{"v":1,"t":"today","ts":1793940923,"i":361,"o":182553,"cw":1404353,"cr":31500339,"c":34.07,"unpriced":[]}',
  '{"v":1,"t":"err","code":"ccusage_failed"}',
];

test('every example frame from the design report is accepted', () => {
  for (const line of REPORT_EXAMPLES) assert.ok(decodeFrame(line), line);
});

function withChange(line: string, change: (frame: any) => void): unknown {
  const frame = JSON.parse(line);
  change(frame);
  return frame;
}

const LIVE = REPORT_EXAMPLES[1]!;
const USAGE = REPORT_EXAMPLES[2]!;

const REJECTED: [string, unknown][] = [
  ['an unknown frame type', { v: 1, t: 'debug' }],
  ['a prototype key as a frame type', { v: 1, t: 'constructor' }],
  ['the wrong protocol version', withChange(REPORT_EXAMPLES[4]!, (f) => (f.v = 2))],
  ['an extra top-level key', withChange(REPORT_EXAMPLES[4]!, (f) => (f.note = 'hi'))],
  ['a free-text error code', withChange(REPORT_EXAMPLES[4]!, (f) => (f.code = 'cannot open /home/x'))],
  ['a host with a space', withChange(REPORT_EXAMPLES[0]!, (f) => (f.host = 'a host'))],
  ['a host path', withChange(REPORT_EXAMPLES[0]!, (f) => (f.host = '/home/x'))],
  ['a long string', withChange(REPORT_EXAMPLES[0]!, (f) => (f.collector = 'x'.repeat(41)))],
  ['an extra agent field', withChange(LIVE, (f) => (f.agents[0].cwd = '/home/x'))],
  ['a terminal title field', withChange(LIVE, (f) => (f.agents[0].title = 'fix'))],
  ['an unlisted agent name', withChange(LIVE, (f) => (f.agents[0].a = 'my-secret-project'))],
  ['a state outside the enum', withChange(LIVE, (f) => (f.agents[0].st = 'thinking'))],
  ['a source outside the enum', withChange(LIVE, (f) => (f.agents[0].src = 'log'))],
  ['a raw session id as key', withChange(LIVE, (f) => (f.agents[0].k = '11111111-aaaa-4aaa-8aaa-111111111111'))],
  ['a seat that is not a pane id', withChange(LIVE, (f) => (f.agents[0].seat = 'client-acme'))],
  ['a negative uptime', withChange(LIVE, (f) => (f.agents[0].up = -1))],
  ['a token count as text', withChange(USAGE, (f) => (f.rows[0].i = '361'))],
  ['a non-integer token count', withChange(USAGE, (f) => (f.rows[0].o = 1.5))],
  ['a NaN-like cost', withChange(USAGE, (f) => (f.rows[0].c = null))],
  ['a missing token field', withChange(USAGE, (f) => delete f.rows[0].cr)],
  ['a model with a slash', withChange(USAGE, (f) => (f.rows[0].m = ['org/model']))],
  ['a model outside the closed pattern', withChange(USAGE, (f) => (f.rows[0].m = ['acme-private-proj:v2']))],
  ['a token as a model', withChange(USAGE, (f) => (f.rows[0].m = ['sk-ant-api03-FAKE']))],
  ['an uppercase model', withChange(USAGE, (f) => (f.rows[0].m = ['CLAUDE-OPUS-5-5']))],
  ['an unpriced name outside the closed pattern', withChange(REPORT_EXAMPLES[3]!, (f) => (f.unpriced = ['box-a.example.com']))],
  ['a projectPath on a row', withChange(USAGE, (f) => (f.rows[0].projectPath = 'x'))],
  ['a free-text timestamp', withChange(USAGE, (f) => (f.rows[0].la = 'yesterday'))],
  ['an array as a frame', []],
  ['null', null],
];

for (const [name, frame] of REJECTED) {
  test(`rejects ${name}`, () => {
    assert.equal(validateFrame(frame), null);
  });
}

test('the fixed model words pass the closed pattern', () => {
  for (const name of ['default', 'other', 'claude-opus-5-5', 'gpt-5', 'o3', 'o4-mini', 'qwen3-coder-plus']) {
    assert.ok(validateFrame(withChange(USAGE, (f) => (f.rows[0].m = [name]))), name);
  }
});

// Every Object.prototype key, at each depth. Built as text because only JSON.parse
// makes `__proto__` an own key, which is what a hostile member can send.
const PROTOTYPE_KEYS = Object.getOwnPropertyNames(Object.prototype);
const SMUGGLED: [string, string, string][] = [
  ...REPORT_EXAMPLES.map((line): [string, string, string] => [`top level of ${JSON.parse(line).t}`, line, '{']),
  ['a live agent', LIVE, '"agents":[{'],
  ['a usage row', USAGE, '"rows":[{'],
];

test('the prototype key list holds the keys that fooled the validator', () => {
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) assert.ok(PROTOTYPE_KEYS.includes(key), key);
});

for (const key of PROTOTYPE_KEYS) {
  for (const [where, line, anchor] of SMUGGLED) {
    test(`rejects ${key} in ${where}, on decode and on encode`, () => {
      const smuggled = line.replace(anchor, `${anchor}"${key}":"LEAK",`);
      assert.notEqual(smuggled, line);
      assert.equal(decodeFrame(smuggled), null);
      assert.equal(validateFrame(JSON.parse(smuggled)), null);
      assert.equal(encodeFrame(JSON.parse(smuggled)), null);
    });
  }
}

test('a required key found only on the prototype does not count', () => {
  const { code, ...rest } = JSON.parse(REPORT_EXAMPLES[4]!);
  assert.equal(validateFrame(Object.assign(Object.create({ code }), rest)), null);
});

test('encodeFrame refuses to serialise a frame that breaks the allowlist', () => {
  const smuggled = { v: 1, t: 'err', code: 'ccusage_failed', detail: 'secret' } as unknown as Frame;
  assert.equal(encodeFrame(smuggled), null);
  assert.equal(encodeFrame({ v: 1, t: 'err', code: 'ccusage_failed' }), '{"v":1,"t":"err","code":"ccusage_failed"}\n');
});

test('malformed JSON decodes to null', () => {
  assert.equal(decodeFrame('{"v":1,'), null);
});
