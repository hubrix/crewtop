import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeKeyer } from '../src/collect/salt.ts';
import { PACKAGE_ROOT } from '../src/collect/ccusage.ts';
import { decodeFrame } from '../src/wire.ts';
import type { Frame } from '../src/wire.ts';

export const CREWTOP_BIN = join(PACKAGE_ROOT, 'bin', 'crewtop');
export const testKeyer = makeKeyer(Buffer.from('test-salt'));

export function tempDir(prefix = 'crewtop-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Writes an executable shell script and returns its path. */
export function writeScript(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A clean environment, so a developer's agent settings cannot reach a test. */
export function isolatedEnv(home: string, binDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: `${binDir}:${process.env.PATH}`, HOME: home, XDG_STATE_HOME: join(home, 'state'), ...extra };
}

export interface StreamCapture {
  stdout: string;
  stderr: string;
  frames: Frame[];
  exitCode: number | null;
}

/** Runs the real CLI collector until `done` holds, then closes stdin as a hub would. */
export function captureStream(env: NodeJS.ProcessEnv, done: (frames: Frame[]) => boolean, timeoutMs = 30_000, cwd?: string): Promise<StreamCapture> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CREWTOP_BIN, 'collect', '--stream'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let frames: Frame[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`collector did not satisfy the condition within ${timeoutMs} ms; got ${frames.map((f) => f.t).join(',')}`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      frames = stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const frame = decodeFrame(line);
          if (!frame) throw new Error('collector wrote a frame that fails validation');
          return frame;
        });
      if (done(frames)) child.stdin.end();
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, frames, exitCode });
    });
  });
}
