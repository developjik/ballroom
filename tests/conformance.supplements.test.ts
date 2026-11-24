import { describe, expect, test } from 'vitest';
import { Ballroom } from '../src/ballroom.js';
import { normalizeCommand } from '../src/commands.js';
import { DamonRunnerAdapter } from '../src/runner/damon.js';
import { HerdrRunnerAdapter } from '../src/runner/herdr.js';
import { MemoryRunnerAdapter } from '../src/runner/memory.js';
import { assertRunnerConformance, runRunnerConformance } from '../src/runner/adapter.js';
import { sha256 } from '../src/util.js';
import { expectApiError, harness, readAll, taskInput } from './helpers.js';

/**
 * The four supplements that the v2 design asked for on top of Phase 1:
 *   1. scope_lock — two tasks may not run on the same repo/path/branch
 *   2. hook re-approval trap — normalised single-use grants
 *   3. artifact read API — metadata + summary + safe preview
 *   4. one RunnerAdapter contract for herdr and damon-agent-core
 * plus the breakers and budget that make the rest safe.
 */
describe('supplement 1 — scope_lock', () => {
  test('a second running task on an overlapping scope is refused with 409 scope_locked', async () => {
    const h = harness();
    const a1 = h.agent('a1');
    const a2 = h.agent('a2');
    const first = h.b.createTask(
      h.owner,
      h.room,
      taskInput({ title: 'edit board', scope_lock: 'repo:developjik/ballroom#branch:main;path:src/board.ts' }),
    );
    const second = h.b.createTask(
      h.owner,
      h.room,
      taskInput({ title: 'edit board api', scope_lock: 'repo:developjik/ballroom#branch:main;path:./src/board.ts/api' }),
    );

    h.b.claim(a1, first.id, { version: first.version });

    const error = await expectApiError(() => h.b.claim(a2, second.id, { version: second.version }), 409, 'scope_locked');
    expect((error.details['conflict'] as { id: string }).id).toBe(first.id);

    // Same repo, different branch and a different path is not a conflict.
    const otherBranch = h.b.createTask(
      h.owner,
      h.room,
      taskInput({ title: 'other branch', scope_lock: 'repo:developjik/ballroom#branch:feature;path:src/docs/' }),
    );
    const claimed = h.b.claim(a2, otherBranch.id, { version: otherBranch.version });
    expect(claimed.status).toBe('running');

    // Once the first task is released the lock is free again.
    const running = h.b.requireTask(first.id);
    h.b.release(a1, first.id, { version: running.version });
    const retried = h.b.claim(a2, second.id, { version: second.version });
    expect(retried.status).toBe('running');
    h.stop();
  });
});

describe('supplement 2 — normalised single-use grants', () => {
  test('a reordered command matches the grant instead of asking the owner again', async () => {
    const h = harness();
    const a1 = h.agent('a1');
    const task = h.b.createTask(h.owner, h.room, taskInput({ title: 'push', risk: 'irreversible', assignee: 'a1' }));
    const claimed = h.b.claim(a1, task.id, { version: task.version });
    readAll(h, a1);

    const first = h.b.gateCheck(a1, {
      task: task.id,
      action_hash: sha256('git push origin main --force'),
      command: 'git push origin main --force',
      risk: 'irreversible',
    });
    expect(first.status).toBe(428);
    const approvalId = first.status === 428 ? first.approval_id : '';

    const waiting = h.b.requireTask(task.id);
    expect(waiting.status).toBe('awaiting_approval');
    expect(waiting.lease_until).toBeNull();
    expect(waiting.turns_used).toBe(1); // one approval request costs one turn

    const decision = h.b.decideApproval(h.owner, approvalId, { decision: 'approve' });
    expect(decision.grant?.kind).toBe('normalized');
    expect(decision.grant?.uses_left).toBe(1);
    expect(decision.task.status).toBe('assigned');
    expect(decision.task.resume_note_md).toContain('git push');

    // The agent re-emits the same command with the flags in another order.
    readAll(h, a1);
    const retry = h.b.gateCheck(a1, {
      task: task.id,
      action_hash: sha256('git push --force origin main'),
      command: 'git push --force origin main',
      risk: 'irreversible',
    });
    expect(retry.status).toBe(200);
    expect(retry.status === 200 && retry.grant.kind).toBe('normalized');
    expect(normalizeCommand('git push --force origin main')).toBe(normalizeCommand('git push origin main --force'));

    // The grant is single use: the same command now needs a new approval.
    readAll(h, a1);
    const again = h.b.gateCheck(a1, {
      task: task.id,
      action_hash: sha256('git push --force origin main'),
      command: 'git push --force origin main',
      risk: 'irreversible',
    });
    expect(again.status).toBe(428);
    expect(again.status === 428 && again.approval_id).not.toBe(approvalId);

    // An unrelated command never matches the old grant (a new approval id).
    readAll(h, a1);
    const unrelated = h.b.gateCheck(a1, {
      task: task.id,
      action_hash: sha256('git push origin main'),
      command: 'git push origin main',
      risk: 'irreversible',
    });
    expect(unrelated.status).toBe(428);
    h.stop();
  });

  test('a pattern grant and a runner-executed grant are both possible', () => {
    const h = harness();
    const a1 = h.agent('a1');
    const task = h.b.createTask(h.owner, h.room, taskInput({ title: 'publish', risk: 'spend', assignee: 'a1' }));
    h.b.claim(a1, task.id, { version: task.version });
    readAll(h, a1);

    const gate = h.b.gateCheck(a1, {
      task: task.id,
      action_hash: sha256('npm publish --tag beta'),
      command: 'npm publish --tag beta',
      risk: 'spend',
    });
    expect(gate.status).toBe(428);
    const decision = h.b.decideApproval(h.owner, gate.status === 428 ? gate.approval_id : '', {
      decision: 'approve',
      grant_kind: 'pattern',
      pattern: '^npm publish',
    });
    expect(decision.grant?.kind).toBe('pattern');

    readAll(h, a1);
    const retry = h.b.gateCheck(a1, {
      task: task.id,
      action_hash: sha256('npm publish --tag latest'),
      command: 'npm publish --tag latest',
      risk: 'spend',
    });
    expect(retry.status).toBe(200);

    // runner_exec: the owner lets the runner execute the action itself (the
    // model never gets the command back).
    const task2 = h.b.createTask(h.owner, h.room, taskInput({ title: 'deploy', risk: 'irreversible', assignee: 'a1' }));
    h.b.claim(a1, task2.id, { version: task2.version });
    readAll(h, a1);
    const gate2 = h.b.gateCheck(a1, {
      task: task2.id,
      action_hash: sha256('kubectl apply -f deploy.yaml'),
      command: 'kubectl apply -f deploy.yaml',
      risk: 'irreversible',
    });
    expect(gate2.status).toBe(428);
    h.b.decideApproval(h.owner, gate2.status === 428 ? gate2.approval_id : '', {
      decision: 'approve',
      grant_kind: 'runner_exec',
    });
    readAll(h, a1);
    const runnerCall = h.b.gateCheck(a1, {
      task: task2.id,
      action_hash: sha256('kubectl apply -f deploy.yaml'),
      command: 'kubectl apply -f deploy.yaml',
      risk: 'irreversible',
      executor: 'runner',
    });
    expect(runnerCall.status).toBe(200);
    expect(runnerCall.status === 200 && runnerCall.grant.kind).toBe('runner_exec');
    h.stop();
  });

  test('denying an approval blocks the task', () => {
    const h = harness();
    const a1 = h.agent('a1');
    const task = h.b.createTask(h.owner, h.room, taskInput({ title: 'delete prod', risk: 'irreversible', assignee: 'a1' }));
    h.b.claim(a1, task.id, { version: task.version });
    readAll(h, a1);
    const gate = h.b.gateCheck(a1, {
      task: task.id,
      action_hash: sha256('rm -rf /srv'),
      command: 'rm -rf /srv',
      risk: 'irreversible',
    });
    const result = h.b.decideApproval(h.owner, gate.status === 428 ? gate.approval_id : '', {
      decision: 'deny',
      note: 'not on a Sunday',
    });
    expect(result.grant).toBeNull();
    expect(result.task.status).toBe('blocked');
    h.stop();
  });

  test('a pending approval expires after 24h and is never executed', () => {
    const h = harness();
    const a1 = h.agent('a1');
    const task = h.b.createTask(h.owner, h.room, taskInput({ title: 'spend', risk: 'spend', assignee: 'a1' }));
    h.b.claim(a1, task.id, { version: task.version });
    readAll(h, a1);
    const gate = h.b.gateCheck(a1, {
      task: task.id,
      action_hash: sha256('npm publish'),
      command: 'npm publish',
      risk: 'spend',
    });
    expect(gate.status).toBe(428);

    h.clock.advanceHours(25);
    h.b.keeper();

    const approval = h.b.approvalById(gate.status === 428 ? gate.approval_id : '');
    expect(approval.status).toBe('expired');
    const blocked = h.b.requireTask(task.id);
    expect(blocked.status).toBe('blocked');
    const events = h.b.store.all<{ payload: string }>(
      `SELECT payload_json AS payload FROM events WHERE task_id = ? AND type = 'task.blocked'`,
      task.id,
    );
    expect(JSON.parse(events.at(-1)!.payload)['reason']).toBe('approval_expired');
    h.stop();
  });
});

describe('supplement 3 — artifacts', () => {
  test('metadata, sha256, summary and a bounded preview come back to the caller', async () => {
    const h = harness();
    const a1 = h.agent('a1');
    const task = h.b.createTask(h.owner, h.room, taskInput({ title: 'report', assignee: 'a1' }));
    const body = 'test output\n✓ 12 tests passed\n';
    const artifact = h.b.putArtifact(a1, h.room, {
      task: task.id,
      name: '../../escape/plan.md',
      content: body,
      summary: 'plan for the migration',
    });

    expect(artifact.name).toBe('plan.md'); // basename only, no traversal
    expect(artifact.bytes).toBe(Buffer.byteLength(body));
    expect(artifact.sha256).toBe(sha256(Buffer.from(body)));
    expect(artifact.preview).toContain('12 tests passed');

    const fetched = h.b.getArtifact(h.owner, artifact.id);
    expect(fetched.artifact.summary).toBe('plan for the migration');
    expect(fetched.download_url).toBe(`/v1/artifacts/${artifact.id}/blob`);
    expect(fetched.artifact.sha256).toBe(artifact.sha256);

    const blob = h.b.readArtifactBlob(h.owner, artifact.id);
    expect(blob.buffer.toString('utf8')).toBe(body);
    await expectApiError(() => h.b.readArtifactBlob(a1, artifact.id), 403, 'forbidden');
    h.stop();
  });

  test('long text is truncated and binary has no preview', () => {
    const h = harness();
    const a1 = h.agent('a1');
    const long = h.b.putArtifact(a1, h.room, { name: 'big.log', content: 'x'.repeat(9000), mime: 'text/plain' });
    expect(long.preview_truncated).toBe(true);
    expect(long.preview?.length).toBe(4096);

    const binary = h.b.putArtifact(a1, h.room, {
      name: 'shot.pdf',
      content: Buffer.from([0, 1, 2, 3, 255]),
      mime: 'application/pdf',
    });
    expect(binary.preview).toBeNull();
    expect(binary.bytes).toBe(5);

    const other = new Ballroom({ dbFile: ':memory:' });
    other.createRoom({ room: 'other', daily_budget_tokens: 1000 });
    const outsider = other.signup({ name: 'z1', kind: 'cli', room: 'other' });
    other.confirmAgent(outsider.agent.id, outsider.confirm_token);
    h.stop();
  });
});

describe('supplement 4 — runner adapter contract', () => {
  test('the reference adapter passes the conformance suite', async () => {
    const checks = await runRunnerConformance(() => new MemoryRunnerAdapter());
    expect(checks.length).toBeGreaterThan(6);
    expect(checks.filter((check) => !check.ok)).toEqual([]);
    assertRunnerConformance(checks);
  });

  test('herdr and damon map the same six calls', () => {
    const herdr = new HerdrRunnerAdapter({ exec: async () => ({ stdout: '{"status":"running"}', stderr: '' }) });
    const start = herdr.startArgs({ agent: 'claude', task: 'task_123', prompt: 'do it', cwd: '/repo' });
    expect(start.slice(0, 4)).toEqual(['herdr', 'agent', 'start', '--name']);
    expect(start).toContain('ballroom-claude-task_123');
    expect(herdr.resumeArgs({ id: 's1', agent: 'claude', task: 't1' }, 'Approval granted')).toContain('prompt');
    expect(herdr.installGateArgs({ id: 's1', agent: 'claude', task: 't1' }, {
      roomUrl: 'https://room.example',
      task: 't1',
      token: 'br_x',
    })).toContain('pre_tool_use');

    const damon = new DamonRunnerAdapter({ exec: async () => ({ stdout: '{"session_id":"s1"}', stderr: '' }) });
    const damonStart = damon.startArgs({ agent: 'codex', task: 'task_1', prompt: 'go', cwd: '/repo' });
    expect(damonStart.slice(0, 3)).toEqual(['damon', 'session', 'create']);
    expect(damon.resumeArgs({ id: 's1', agent: 'codex', task: 'task_1' }, 'note').slice(0, 3)).toEqual([
      'damon',
      'session',
      'resume',
    ]);
  });
});

describe('breakers and budget', () => {
  test('the loop signature stops an echo on the fourth identical message', async () => {
    const h = harness();
    const a1 = h.agent('a1');
    const a2 = h.agent('a2');
    for (let i = 0; i < 3; i += 1) {
      const posted = h.b.postMessage(a1, h.room, { content: 'ping', to: 'a2', idem_key: `loop-${i}` });
      expect(posted.duplicate).toBe(false);
    }
    await expectApiError(
      () => h.b.postMessage(a1, h.room, { content: 'ping', to: 'a2', idem_key: 'loop-3' }),
      429,
      'loop_detected',
    );
    // A different message is fine.
    expect(h.b.postMessage(a1, h.room, { content: 'pong', to: 'a2', idem_key: 'loop-4' }).seq).toBeGreaterThan(0);
    const tripped = h.b.store.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events WHERE room = ? AND type = 'breaker.tripped'`,
      h.room,
    )!.n;
    expect(tripped).toBe(1);
    h.stop();
  });

  test('per-agent rate limit refuses the 11th message in a minute', async () => {
    const h = harness();
    const a1 = h.agent('a1');
    for (let i = 0; i < 10; i += 1) {
      h.b.postMessage(a1, h.room, { content: `message ${i}`, idem_key: `rate-${i}` });
    }
    await expectApiError(
      () => h.b.postMessage(a1, h.room, { content: 'message 10', idem_key: 'rate-10' }),
      429,
      'rate_limited',
    );
    h.clock.advanceMinutes(2);
    const later = h.b.postMessage(a1, h.room, { content: 'message 11', idem_key: 'rate-11' });
    expect(later.duplicate).toBe(false);
    h.stop();
  });

  test('usage over the turn budget blocks the task with 429 budget_exhausted', async () => {
    const h = harness();
    const a1 = h.agent('a1');
    const task = h.b.createTask(h.owner, h.room, taskInput({ budget_turns: 3, assignee: 'a1' }));
    h.b.claim(a1, task.id, { version: task.version });
    await expectApiError(
      () => h.b.reportUsage(a1, { task: task.id, turns: 4, tokens_in: 100, tokens_out: 50 }),
      429,
      'budget_exhausted',
    );
    const blocked = h.b.requireTask(task.id);
    expect(blocked.status).toBe('blocked');
    expect(blocked.turns_used).toBe(4);
    h.stop();
  });

  test('a missing room budget is refused at creation', async () => {
    const b = new Ballroom({ dbFile: ':memory:' });
    await expectApiError(
      () => b.createRoom({ room: 'no-budget', daily_budget_tokens: 0 }),
      400,
      'bad_request',
    );
    b.close();
  });
});

describe('unattended rooms', () => {
  test('a human check cannot be created in an unattended room', async () => {
    const h = harness({ unattended: true });
    await expectApiError(
      () => h.b.createTask(h.owner, h.room, { title: 'needs approval', check: { kind: 'human' } }),
      400,
      'bad_request',
    );
    // check omitted defaults to human, so it is refused too.
    await expectApiError(
      () => h.b.createTask(h.owner, h.room, { title: 'implicit human' }),
      400,
      'bad_request',
    );
    const ok = h.b.createTask(h.owner, h.room, taskInput({ title: 'machine check' }));
    expect(ok.check.kind).toBe('command');
    h.stop();
  });

  test('an unattended room still accepts command, artifact and http checks', () => {
    const h = harness({ unattended: true });
    for (const check of [
      { kind: 'command' as const, target: 'npm test' },
      { kind: 'artifact' as const, target: 'out.md' },
      { kind: 'http' as const, target: 'https://example.com/health' },
    ]) {
      const task = h.b.createTask(h.owner, h.room, { title: `check ${check.kind}`, check });
      expect(task.check.kind).toBe(check.kind);
    }
    h.stop();
  });
});
