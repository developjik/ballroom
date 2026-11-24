import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { Ballroom } from '../src/ballroom.js';
import { CliRunnerAdapter } from '../src/runner/cli.js';
import { Worker } from '../src/worker/loop.js';
import { RoomApi } from '../src/worker/api.js';
import { startServer, type RunningServer } from './server.js';

/**
 * The whole loop, end to end, over real HTTP and real processes:
 *
 *   task assigned → worker long-polls → claim → mock CLI runs
 *   → its pre-tool hook calls /v1/gate/check → 428 → the turn ends
 *   → the owner approves → the worker resumes the CLI
 *   → the hook passes once → the CLI writes evidence
 *   → the worker uploads the artifact and completes → review → owner verifies → done
 *
 * Every hop is the real one: no in-process shortcut between the hook and the
 * room, and the "agent" is a separate OS process obeying the hook's exit code.
 */
const MOCK = fileURLToPath(new URL('./fixtures/mock-agent.mjs', import.meta.url));
const owners = { owner: 'owner', agent: null };

const running: { b: Ballroom; server: RunningServer }[] = [];

afterEach(async () => {
  for (const node of running.splice(0)) {
    await node.server.close();
    node.b.close();
  }
});

describe('worker E2E — hook 428 → approval → resume → artifact → done', () => {
  test('the whole chain on one task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ballroom-e2e-'));
    const b = new Ballroom({
      dbFile: ':memory:',
      ownerToken: 'owner-token',
      artifactsDir: join(dir, 'artifacts'),
    });
    b.createRoom({ room: 'e2e', daily_budget_tokens: 2_000_000, approval_ttl_minutes: 60 });
    const signup = b.signup({ name: 'claude', kind: 'cli', room: 'e2e', gate: 'hook', wake: 'poll' });
    b.confirmAgent(signup.agent.id, signup.confirm_token);
    const server = await startServer(b, 'owner-token');
    running.push({ b, server });

    const task = b.createTask(owners, 'e2e', {
      title: 'ship the branch',
      body_md: 'Run the suite, then push the branch.',
      kind: 'cli',
      risk: 'irreversible',
      assignee: 'claude',
      check: { kind: 'artifact', target: 'out/evidence.md' },
      budget_turns: 8,
    });

    const lines: string[] = [];
    const worker = new Worker({
      baseUrl: server.base,
      token: signup.key,
      agent: 'claude',
      room: 'e2e',
      cwd: dir,
      runner: new CliRunnerAdapter({
        name: 'mock',
        command: [process.execPath, MOCK, '--prompt', '{prompt}', '--gate-wait', '5000'],
        resumeCommand: [process.execPath, MOCK, '--prompt', '{note}', '--resume', '{session}', '--gate-wait', '5000'],
        outputs: ['out/evidence.md'],
        cwd: dir,
      }),
      waitSeconds: 1,
      pollMs: 30,
      leaseMinutes: 2,
      approvalTimeoutMs: 25_000,
      turnTimeoutMs: 20_000,
      log: (line) => lines.push(line),
    });

    // The owner answers the approval as soon as the room has one.
    const ownerApi = new RoomApi(server.base, 'owner-token');
    const approver = (async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const answer = await ownerApi.http.expect<{ approvals: { id: string; normalized_command: string | null }[] }>(
          'GET',
          '/v1/rooms/e2e/approvals?status=pending',
        );
        const pending = answer.approvals[0];
        if (pending) {
          // Leave it pending for a moment so the worker has to notice
          // `awaiting_approval` and wait, which is the path that matters.
          await new Promise((resolve) => setTimeout(resolve, 400));
          const decision = await ownerApi.decideApproval(pending.id, 'approve', 'go ahead, one push');
          return { approval: pending, decision };
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      throw new Error('no approval appeared within 20s');
    })();

    const [polled, approved] = await Promise.all([worker.pollOnce(), approver]);

    expect(approved.approval.normalized_command).toBe('git push --force origin main');
    expect(polled.outcomes).toHaveLength(1);
    const outcome = polled.outcomes[0]!;
    expect(outcome.result, JSON.stringify({ detail: outcome.detail, lines })).toBe('completed');
    expect(outcome.status).toBe('review');
    expect(outcome.artifacts?.length).toBeGreaterThan(0);

    // The board is where the loop left it: review, waiting for a verifier.
    const after = b.requireTask(task.id);
    expect(after.status).toBe('review');
    expect(after.assignee).toBe('claude');
    expect(after.proof).toMatchObject({ runner: 'mock' });
    expect(after.turns_used).toBeGreaterThanOrEqual(2); // two turns: blocked, then approved

    // The artifact the CLI wrote is in the room, with its bytes and summary.
    const artifacts = b.store
      .all<{ id: string; name: string; summary: string | null; storage_path: string }>(
        'SELECT id, name, summary, storage_path FROM artifacts WHERE task_id = ? ORDER BY created_at ASC',
        task.id,
      )
      .map((row) => ({ ...row, content: readFileSync(row.storage_path, 'utf8') }));
    const evidence = artifacts.find((artifact) => artifact.name === 'evidence.md');
    expect(evidence).toBeDefined();
    expect(evidence!.content).toContain('git push --force origin main');
    expect(evidence!.content).toContain('allowed by the room');
    expect(artifacts.some((artifact) => artifact.name.startsWith('run-'))).toBe(true);

    // The event log tells the whole story in order.
    const types = b.store
      .all<{ type: string }>('SELECT type FROM events WHERE task_id = ? ORDER BY seq ASC', task.id)
      .map((row) => row.type);
    expect(types).toContain('task.gate');
    expect(types).toContain('approval.created');
    expect(types).toContain('task.approval_decided');
    expect(types).toContain('grant.created');
    expect(types).toContain('grant.consumed');
    expect(types).toContain('artifact.created');
    expect(types.indexOf('approval.created')).toBeLessThan(types.indexOf('grant.consumed'));
    expect(types.indexOf('grant.consumed')).toBeLessThan(types.indexOf('task.completed'));

    // Exactly one approval: the reordered retry used the grant instead of asking again.
    expect(b.listApprovals('e2e')).toHaveLength(1);
    expect(b.listApprovals('e2e')[0]!.status).toBe('approved');

    // The worker stops at review; the owner turns it into done.
    const verified = b.verify(owners, task.id, { result: 'passed', evidence: 'evidence.md in the room' });
    expect(verified.status).toBe('done');

    expect(lines.join('\n')).toContain('claimed');
    expect(lines.join('\n')).toContain('waiting for the owner');
    expect(lines.join('\n')).toContain('resuming');
  }, 90_000);

  test('a task assigned to another agent is left alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ballroom-e2e-skip-'));
    const b = new Ballroom({ dbFile: ':memory:', ownerToken: 'owner-token', artifactsDir: join(dir, 'artifacts') });
    b.createRoom({ room: 'e2e2', daily_budget_tokens: 100_000 });
    const mine = b.signup({ name: 'claude', kind: 'cli', room: 'e2e2', gate: 'hook' });
    b.confirmAgent(mine.agent.id, mine.confirm_token);
    const other = b.signup({ name: 'codex', kind: 'cli', room: 'e2e2', gate: 'hook' });
    b.confirmAgent(other.agent.id, other.confirm_token);
    const server = await startServer(b, 'owner-token');
    running.push({ b, server });

    const task = b.createTask(owners, 'e2e2', {
      title: 'not mine',
      kind: 'cli',
      risk: 'write_local',
      assignee: 'codex',
      check: { kind: 'command', target: 'npm test' },
    });

    const worker = new Worker({
      baseUrl: server.base,
      token: mine.key,
      agent: 'claude',
      cwd: dir,
      runner: new CliRunnerAdapter({ command: [process.execPath, MOCK, '--prompt', '{prompt}'], cwd: dir }),
      waitSeconds: 1,
      pollMs: 30,
      log: () => {},
    });
    const result = await worker.pollOnce();
    // Nothing in the inbox is for me, so nothing is even considered.
    expect(result.outcomes).toEqual([]);
    expect(b.requireTask(task.id).status).toBe('assigned');
    expect(b.requireTask(task.id).assignee).toBe('codex');
  }, 30_000);

  test('a runner that crashes blocks the task instead of leaving it running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ballroom-e2e-crash-'));
    const b = new Ballroom({ dbFile: ':memory:', ownerToken: 'owner-token', artifactsDir: join(dir, 'artifacts') });
    b.createRoom({ room: 'e2e3', daily_budget_tokens: 100_000 });
    const signup = b.signup({ name: 'claude', kind: 'cli', room: 'e2e3', gate: 'hook' });
    b.confirmAgent(signup.agent.id, signup.confirm_token);
    const server = await startServer(b, 'owner-token');
    running.push({ b, server });

    const task = b.createTask(owners, 'e2e3', {
      title: 'crash',
      kind: 'cli',
      risk: 'write_local',
      assignee: 'claude',
      check: { kind: 'command', target: 'npm test' },
    });

    const worker = new Worker({
      baseUrl: server.base,
      token: signup.key,
      agent: 'claude',
      cwd: dir,
      runner: new CliRunnerAdapter({
        command: [process.execPath, MOCK, '--prompt', '{prompt}', '--fail'],
        cwd: dir,
      }),
      waitSeconds: 1,
      pollMs: 30,
      turnTimeoutMs: 10_000,
      log: () => {},
    });
    const result = await worker.pollOnce();
    expect(result.outcomes[0]?.result).toBe('blocked');
    const after = b.requireTask(task.id);
    expect(after.status).toBe('blocked');
  }, 40_000);
});
