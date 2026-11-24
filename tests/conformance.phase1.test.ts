import { describe, expect, test } from 'vitest';
import { harness, readAll, taskInput } from './helpers.js';

/**
 * Phase 1 completion definition (docs/SPEC.md §12):
 *   - exactly one of five concurrent claims wins
 *   - 100 retries of the same idem_key leave zero duplicate events
 *   - a 24h fake-clock wait keeps the assignee, and a lease expiry is not a failure
 *   - a complete with an unread event is refused with 409
 */
describe('Phase 1 completion definition', () => {
  test('five agents claim the same task at once: exactly one wins', () => {
    const h = harness();
    const task = h.b.createTask(h.owner, h.room, taskInput({ title: 'contended' }));
    const agents = ['a1', 'a2', 'a3', 'a4', 'a5'].map((name) => h.agent(name));

    const results = agents.map((actor) => {
      try {
        const claimed = h.b.claim(actor, task.id, { version: task.version, lease_minutes: 5 });
        return { ok: true as const, task: claimed };
      } catch (error) {
        return { ok: false as const, error: error as { status?: number; code?: string } };
      }
    });

    const winners = results.filter((result) => result.ok);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.task.status).toBe('running');
    expect(winners[0]!.task.assignee).toBe(agents[0]!.agent);

    for (const loser of results.filter((result) => !result.ok)) {
      expect(loser.error.status).toBe(409);
      expect(['invalid_transition', 'version_conflict', 'already_claimed']).toContain(loser.error.code);
    }

    const final = h.b.requireTask(task.id);
    expect(final.status).toBe('running');
    expect(final.version).toBe(2);
    expect(final.lease_until).not.toBeNull();
    h.stop();
  });

  test('the same idem_key sent 100 times produces one event', () => {
    const h = harness();
    const a1 = h.agent('a1');
    const first = h.b.postMessage(a1, h.room, { content: 'build started', idem_key: 'idem-1' });

    let duplicates = 0;
    for (let i = 0; i < 100; i += 1) {
      const again = h.b.postMessage(a1, h.room, { content: 'build started', idem_key: 'idem-1' });
      expect(again.seq).toBe(first.seq);
      if (again.duplicate) duplicates += 1;
    }

    const stored = h.b.store.one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM events WHERE room = ? AND actor_agent = ? AND idem_key = ?',
      h.room,
      'a1',
      'idem-1',
    )!.n;

    expect(duplicates).toBe(100);
    expect(stored).toBe(1);
    h.stop();
  });

  test('24h with a fake clock keeps the assignee, and lease expiry is not a failure', () => {
    const h = harness();
    const a1 = h.agent('a1', { stale_after_min: 2880 }); // 48h: only the lease rule is under test
    const task = h.b.createTask(h.owner, h.room, taskInput({ assignee: 'a1' }));
    const running = h.b.claim(a1, task.id, { version: task.version, lease_minutes: 5 });
    expect(running.lease_until).toBe('2026-11-24T09:05:00.000Z');

    h.clock.advanceHours(24);
    h.b.keeper();

    const after = h.b.requireTask(task.id);
    expect(after.status).toBe('assigned');
    expect(after.assignee).toBe('a1');
    expect(after.assigned_at).toBe(task.assigned_at);
    expect(after.lease_until).toBeNull();
    expect(after.attempt).toBe(0);

    const expired = h.b.store.all<{ type: string; payload: string }>(
      `SELECT type, payload_json AS payload FROM events WHERE task_id = ? AND type = 'task.lease_expired'`,
      task.id,
    );
    expect(expired).toHaveLength(1);
    expect(JSON.parse(expired[0]!.payload)).toMatchObject({ assignee: 'a1', attempt: 0 });

    // The agent can still complete after the lease expired (slow is not failed).
    const cursor = readAll(h, a1);
    const completed = h.b.complete(a1, task.id, { version: after.version, read_seq: cursor, proof: { ok: true } });
    expect(completed.status).toBe('review');
    h.stop();
  });

  test('complete with read_seq behind last_seq is refused with 409 unread_events', () => {
    const h = harness();
    const a1 = h.agent('a1');
    const a2 = h.agent('a2');
    const task = h.b.createTask(h.owner, h.room, taskInput({ assignee: 'a1' }));
    const running = h.b.claim(a1, task.id, { version: task.version, lease_minutes: 10 });
    const staleRead = running.last_seq;

    const message = h.b.postMessage(a2, h.room, {
      task: task.id,
      content: 'do not forget the migration note',
      idem_key: 'unread-1',
    });
    expect(message.seq).toBeGreaterThan(staleRead);

    let unread: unknown[] = [];
    try {
      h.b.complete(a1, task.id, { version: running.version, read_seq: staleRead, proof: { ok: true } });
    } catch (error) {
      const api = error as { status: number; code: string; details: { events?: unknown[] } };
      expect(api.status).toBe(409);
      expect(api.code).toBe('unread_events');
      unread = api.details.events ?? [];
    }
    expect(unread).toHaveLength(1);

    const cursor = readAll(h, a1);
    const current = h.b.requireTask(task.id);
    const completed = h.b.complete(a1, task.id, { version: current.version, read_seq: cursor, proof: { ok: true } });
    expect(completed.status).toBe('review');
    expect(completed.verify).toBe('none');

    const verified = h.b.verify(h.owner, task.id, { result: 'passed', evidence: { exit_code: 0 } });
    expect(verified.status).toBe('done');
    h.stop();
  });
});
