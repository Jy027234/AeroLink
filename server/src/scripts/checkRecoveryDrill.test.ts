import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { claimOwnedWorkDir } from './checkRecoveryDrill.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

describe('PostgreSQL recovery drill work-directory safety', () => {
  it('refuses a pre-existing directory and preserves its files', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aerolink-d09-existing-'));
    cleanupPaths.push(workDir);
    const markerPath = path.join(workDir, 'do-not-delete.txt');
    await fs.writeFile(markerPath, 'existing user data\n', 'utf8');

    await expect(claimOwnedWorkDir(workDir)).rejects.toThrow(/must be a new directory/);
    await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe('existing user data\n');
  });

  it('entrypoint rejects a pre-existing directory without deleting it during cleanup', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aerolink-d09-entrypoint-'));
    cleanupPaths.push(workDir);
    const markerPath = path.join(workDir, 'do-not-delete.txt');
    await fs.writeFile(markerPath, 'existing user data\n', 'utf8');
    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'checkRecoveryDrill.ts');

    const result = await new Promise<{ code: number; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
        cwd: path.resolve(process.cwd()),
        env: {
          ...process.env,
          D09_WORK_DIR: workDir,
          D09_PG_CONTAINER: 'isolated-test-container',
          D09_PG_ADMIN_DB: 'aerolink_review',
        },
        windowsHide: true,
      });
      const output: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => output.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, output: Buffer.concat(output).toString('utf8') }));
    });

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/must be a new directory/);
    await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe('existing user data\n');
  });
});
