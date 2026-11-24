import { describe, expect, test } from 'vitest';
import { harness, readAll, taskInput } from './helpers.js';

describe('keeper — wake conditions', () => {
  test('a waiting task wakes when its dependency reaches done', () => {
    const h = harness();
    const a1 = h.agent('a1');
    const prerequisite = h.b.createTask(h.owner, h.room, taskInput({ title: 'prerequisite', assignee: 'a1' }));
    const waiter = h.b.createTask(
      h.owner,
      h.room,
      taskInput({ title: 'dependent', assignee: 'a1', depends_on: [prerequisite.id] }),
    );

    const waiting = h.b.claim(a1, waiter.id, { version: waiter.version });
    h.b.wait(a1, waiter.id, { version: waiting.version, reason: 'dependency', resume_note: 'continue after prerequisite' });
    expect(h.b.requireTask(waiter.id).status).toBe('waiting');

    const prereq = h.b.claim(a1, prerequisite.id, { version: prerequisite.version });
    readAll(h, a1);
    h.b.complete(a1, prerequisite.id, { version: prereq.version, read_seq: h.b.requireTask(prerequisite.id).last_seq, proof: { ok: true } });
    const review = h.b.requireTask(prerequisite.id);
    h.b.verify(h.owner, prerequisite.id, { result: 'passed', evidence: { exit: 0 } });
    expect(h.b.requireTask(prerequisite.id).status).toBe('done');
    void review;

    const report = h.b.keeper();
    expect(report.woke).toEqual([{ task: waiter.id, reason: 'dependency' }]);
    const woken = h.b.requireTask(waiter.id);
    expect(woken.status).toBe('assigned');
    expect(woken.assignee).toBe('a1');
    expect(woken.resume_note_md).toBe('continue after prerequisite');
    h.stop();
  });

  test('a mention wakes the assignee', () => {
    const h = harness();
    const a1 = h.agent('a1');
    const a2 = h.agent('a2');
    const task = h.b.createTask(h.owner, h.room, taskInput({ title: 'waiting for a ping', assignee: 'a1' }));
    const claimed = h.b.claim(a1, task.id, { version: task.version });
    h.b.wait(a1, task.id, { version: claimed.version, reason: 'need info', resume_note: 'read the ping' });

    h.b.postMessage(a2, h.room, { content: '@a1 the schema is in migrations/', idem_key: 'mention-1' });
    const report = h.b.keeper();
    expect(report.woke).toEqual([{ task: task.id, reason: 'mention' }]);
    expect(h.b.requireTask(task.id).status).toBe('assigned');
    h.stop();
  });

  test('a clock wake fires when wait_until passes', () => {
    const h = harness();
    const a1 = h.agent('a1');
    const task = h.b.createTask(h.owner, h.room, taskInput({ title: 'wait for CI', assignee: 'a1' }));
    const claimed = h.b.claim(a1, task.id, { version: task.version });
    h.b.wait(a1, task.id, {
      version: claimed.version,
      reason: 'ci pending',
      until: '2026-11-24T10:00:00.000Z',
      resume_note: 'check the CI result',
    });

    expect(h.b.keeper().woke).toEqual([]);
    h.clock.advanceMinutes(61);
    expect(h.b.keeper().woke).toEqual([{ task: task.id, reason: 'clock' }]);
    h.stop();
  });
});

describe('keeper — assignment rules', () => {
  test('dispatch picks the least busy capable agent', () => {
    const h = harness({ autodispatch: true });
    h.agent('a1');
    h.agent('a2');
    const busy = h.b.createTask(h.owner, h.room, taskInput({ title: 'already assigned', assignee: 'a1' }));
    void busy;
    const task = h.b.createTask(h.owner, h.room, taskInput({ title: 'new work' }));
    const report = h.b.keeper();
    expect(report.dispatched).toEqual([task.id]);
    expect(h.b.requireTask(task.id).assignee).toBe('a2'); // a1 already has one
    h.stop();
  });

  test('a risky task is not given to a vendor gate without delegation', () => {
    const h = harness({ autodispatch: true });
    h.agent('pally', { kind: 'hosted', gate: 'vendor', wake: 'poll', approval_delegated: false });
    const task = h.b.createTask(h.owner, h.room, taskInput({ title: 'spend money', kind: 'hosted', risk: 'spend' }));
    const report = h.b.keeper();
    expect(report.blocked).toEqual([{ task: task.id, reason: 'no_capable_agent' }]);
    expect(h.b.requireTask(task.id).status).toBe('blocked');
    h.stop();
  });

  test('a stale assignee loses the task (but not the attempt count)', () => {
    const h = harness();
    const a1 = h.agent('a1', { stale_after_min: 30 });
    const task = h.b.createTask(h.owner, h.room, taskInput({ title: 'abandoned', assignee: 'a1' }));
    h.clock.advanceMinutes(31);
    const report = h.b.keeper();
    expect(report.unassigned).toEqual([{ task: task.id, reason: 'stale' }]);
    const open = h.b.requireTask(task.id);
    expect(open.status).toBe('open');
    expect(open.assignee).toBeNull();
    expect(open.attempt).toBe(0);
    h.stop();
  });

  test('two rejections in a row release the task to the pool', () => {
    const h = harness();
    const a1 = h.agent('a1');
    const reviewer = h.agent('reviewer');
    const task = h.b.createTask(h.owner, h.room, taskInput({ assignee: 'a1' }));

    for (const round of [1, 2]) {
      const current = h.b.requireTask(task.id);
      let version = current.version;
      if (current.status === 'assigned') {
        const claimed = h.b.claim(a1, task.id, { version: current.version });
        version = claimed.version;
      }
      readAll(h, a1);
      h.b.complete(a1, task.id, { version, read_seq: h.b.requireTask(task.id).last_seq, proof: { round } });
      const verified = h.b.verify(reviewer, task.id, { result: 'rejected', evidence: { round } });
      expect(verified.attempt).toBe(round);
      expect(verified.status).toBe(round === 1 ? 'assigned' : 'open');
    }
    const final = h.b.requireTask(task.id);
    expect(final.assignee).toBeNull();
    expect(final.attempt).toBe(2);
    h.stop();
  });
});
