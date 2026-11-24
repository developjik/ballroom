import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { Ballroom } from '../src/ballroom.js';

const WORKER = fileURLToPath(new URL('./workers/claim-worker.ts', import.meta.url));

/**
 * The in-process test can be satisfied by a single-threaded loop. This one puts
 * five real OS processes on one SQLite file, which is the deployment shape
 * (one writer per room, many readers), and checks that the version CAS still
 * lets exactly one of them win.
 */
describe('claim race across processes', () => {
  test('five processes, one SQLite file, one winner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ballroom-race-'));
    const dbFile = join(dir, 'room.sqlite');
    const b = new Ballroom({ dbFile });
    b.createRoom({ room: 'race', daily_budget_tokens: 1_000_000, autodispatch: false });
    const names = ['p1', 'p2', 'p3', 'p4', 'p5'];
    for (const name of names) {
      const { agent, confirm_token } = b.signup({ name, kind: 'cli', room: 'race', gate: 'hook' });
      b.confirmAgent(agent.id, confirm_token);
    }
    const task = b.createTask(
      { owner: 'owner', agent: null },
      'race',
      { title: 'contended', kind: 'cli', risk: 'write_local', check: { kind: 'command', target: 'npm test' } },
    );
    b.close();

    const goAt = Date.now() + 1500;
    const runs = names.map(
      (name) =>
        new Promise<{ ok: boolean; status?: number; code?: string }>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ['--import', 'tsx', WORKER, dbFile, task.id, name, String(task.version), String(goAt)],
            { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let out = '';
          let err = '';
          child.stdout.on('data', (chunk) => (out += String(chunk)));
          child.stderr.on('data', (chunk) => (err += String(chunk)));
          child.on('error', reject);
          child.on('close', () => {
            try {
              resolve(JSON.parse(out.trim().split('\n').at(-1) ?? '{}'));
            } catch {
              reject(new Error(`worker failed: ${err || out}`));
            }
          });
        }),
    );

    const results = await Promise.all(runs);
    const winners = results.filter((result) => result.ok);
    expect(winners).toHaveLength(1);
    for (const loser of results.filter((result) => !result.ok)) {
      expect(loser.status).toBe(409);
      expect(['invalid_transition', 'version_conflict', 'already_claimed']).toContain(loser.code);
    }

    const after = new Ballroom({ dbFile });
    const winner = after.requireTask(task.id);
    expect(winner.status).toBe('running');
    expect(winners[0]!.status).toBe('running');
    const claims = after.store.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task.claimed'`,
      task.id,
    )!.n;
    expect(claims).toBe(1);
    after.close();
  }, 40_000);
});
