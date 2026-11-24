import { agentCanTake, KEEPER_ACTOR, type Ballroom } from './ballroom.js';
import { mapAgent, mapTask, type Row } from './db.js';
import type { Event, Task } from './types.js';
import { addMinutes } from './util.js';

export interface KeeperReport {
  now: string;
  dispatched: string[];
  woke: { task: string; reason: string }[];
  leasesExpired: string[];
  approvalsExpired: string[];
  unassigned: { task: string; reason: string }[];
  blocked: { task: string; reason: string }[];
}

/**
 * The keeper is a deterministic loop. It does not call a model (SPEC §5.3):
 * every decision below is a comparison on exact values, which is what makes the
 * whole run replayable from the event log.
 *
 * Order matters:
 *   1. budget      — a task that already overspent must not be dispatched again
 *   2. lease       — running → assigned, assignment kept, attempt NOT bumped
 *   3. approvals   — pending → expired, task → blocked(approval_expired)
 *   4. wake        — waiting → assigned when a wake condition is met
 *   5. stale       — assigned with a silent assignee → open
 *   6. dispatch    — open → assigned (fewest active tasks wins)
 */
export function keeperTick(b: Ballroom): KeeperReport {
  const now = b.nowIso();
  const report: KeeperReport = {
    now,
    dispatched: [],
    woke: [],
    leasesExpired: [],
    approvalsExpired: [],
    unassigned: [],
    blocked: [],
  };

  for (const room of b.listRooms()) {
    const tasks = b.listTasks(room.room);
    const keeper: { owner: string; agent: string } = { owner: room.owner, agent: KEEPER_ACTOR };

    // 1 — budget ------------------------------------------------------------
    for (const task of tasks) {
      if (!['assigned', 'running', 'awaiting_approval', 'waiting'].includes(task.status)) continue;
      const overTurns = task.budget_turns > 0 && task.turns_used > task.budget_turns;
      const overTokens = task.budget_tokens !== null && task.tokens_used > task.budget_tokens;
      if (!overTurns && !overTokens) continue;
      b.mutate(
        keeper,
        task,
        { status: 'blocked', lease_until: null },
        'task.blocked',
        { reason: 'budget', scope: overTurns ? 'task.turns' : 'task.tokens' },
        { idem: `keeper:budget:${task.id}:${task.version}` },
      );
      report.blocked.push({ task: task.id, reason: 'budget' });
    }

    // 2 — lease expiry ------------------------------------------------------
    for (const task of tasks) {
      if (task.status !== 'running' || !task.lease_until) continue;
      if (Date.parse(task.lease_until) > Date.parse(now)) continue;
      const current = b.requireTask(task.id);
      if (current.status !== 'running') continue;
      b.mutate(
        keeper,
        current,
        { status: 'assigned', lease_until: null },
        'task.lease_expired',
        { assignee: current.assignee, lease_until: task.lease_until, attempt: current.attempt },
        { idem: `keeper:lease:${task.id}:${task.lease_until}` },
      );
      report.leasesExpired.push(task.id);
    }

    // 3 — approval expiry ---------------------------------------------------
    for (const approval of b.listApprovals(room.room, 'pending')) {
      if (Date.parse(approval.expires_at) > Date.parse(now)) continue;
      b.store.run(
        `UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'`,
        now,
        approval.id,
      );
      b.appendEvent({
        room: room.room,
        type: 'approval.expired',
        actor: keeper,
        task_id: approval.task_id,
        payload: { approval_id: approval.id },
        idem_key: `keeper:approval:${approval.id}`,
      });
      const task = b.getTask(approval.task_id);
      if (task && task.status === 'awaiting_approval') {
        b.mutate(
          keeper,
          task,
          { status: 'blocked', lease_until: null },
          'task.blocked',
          { reason: 'approval_expired', approval_id: approval.id },
          { idem: `keeper:approval-block:${approval.id}` },
        );
        report.blocked.push({ task: task.id, reason: 'approval_expired' });
      }
      report.approvalsExpired.push(approval.id);
    }

    // 4 — wake --------------------------------------------------------------
    for (const task of tasks) {
      if (task.status !== 'waiting') continue;
      const current = b.requireTask(task.id);
      if (current.status !== 'waiting') continue;
      const reason = wakeReason(b, current, now);
      if (!reason) continue;
      b.mutate(
        keeper,
        current,
        { status: 'assigned', wait_reason: null, wait_until: null, wait_since_seq: null, lease_until: null },
        'task.woke',
        { reason, resume_note: current.resume_note_md },
        { idem: `keeper:wake:${current.id}:${current.wait_since_seq}` },
      );
      report.woke.push({ task: current.id, reason });
    }

    // 5 — stale assignment -------------------------------------------------
    for (const task of tasks) {
      if (task.status !== 'assigned') continue;
      const current = b.requireTask(task.id);
      if (current.status !== 'assigned' || !current.assignee) continue;
      const agentRow = b.store.one<Row>('SELECT * FROM agents WHERE id = ?', current.assignee);
      if (!agentRow) continue;
      const agent = mapAgent(agentRow);
      const lastActivity = Math.max(
        Date.parse(current.assigned_at ?? current.created_at),
        agent.last_seen_at ? Date.parse(agent.last_seen_at) : 0,
      );
      if (Date.parse(now) - lastActivity < agent.stale_after_min * 60_000) continue;
      b.mutate(
        keeper,
        current,
        { status: 'open', assignee: null, assigned_at: null, lease_until: null },
        'task.unassigned',
        { assignee: current.assignee, reason: 'stale', stale_after_min: agent.stale_after_min },
        { idem: `keeper:stale:${current.id}:${current.assigned_at}` },
      );
      report.unassigned.push({ task: current.id, reason: 'stale' });
    }

    // 6 — dispatch ---------------------------------------------------------
    if (!room.autodispatch) continue;
    const agents = b.listAgents(room.room).filter((agent) => agent.status === 'active');
    const fresh = b.listTasks(room.room).filter((task) => task.status === 'open');
    for (const task of fresh) {
      const current = b.requireTask(task.id);
      if (current.status !== 'open') continue;
      if (!dependenciesSatisfied(b, current)) continue;
      const capable = agents.filter((agent) => agentCanTake(agent, current));
      if (capable.length === 0) {
        if (agents.length === 0) continue; // no agents yet; leave it open
        b.mutate(
          keeper,
          current,
          { status: 'blocked' },
          'task.blocked',
          { reason: 'no_capable_agent' },
          { idem: `keeper:nocap:${current.id}:${current.version}` },
        );
        report.blocked.push({ task: current.id, reason: 'no_capable_agent' });
        continue;
      }
      const activity = new Map<string, number>();
      for (const agent of agents) activity.set(agent.id, 0);
      for (const other of b.listTasks(room.room)) {
        if (!other.assignee || !activity.has(other.assignee)) continue;
        if (['assigned', 'running', 'waiting', 'awaiting_approval', 'review'].includes(other.status)) {
          activity.set(other.assignee, (activity.get(other.assignee) ?? 0) + 1);
        }
      }
      capable.sort((left, right) => {
        const delta = (activity.get(left.id) ?? 0) - (activity.get(right.id) ?? 0);
        if (delta !== 0) return delta;
        return left.id.localeCompare(right.id);
      });
      const chosen = capable[0]!;
      b.assign(keeper, current.id, { version: current.version, agent: chosen.id });
      report.dispatched.push(current.id);
    }
  }

  return report;
}

function dependenciesSatisfied(b: Ballroom, task: Task): boolean {
  if (task.depends_on.length === 0) return true;
  return task.depends_on.every((id) => {
    const dependency = b.getTask(id);
    return dependency ? dependency.status === 'done' : false;
  });
}

/**
 * Four exact wake conditions (SPEC §5.3): a task event, a mention, a dependency
 * reaching `done`, and a wall-clock time. Nothing here parses prose.
 */
function wakeReason(b: Ballroom, task: Task, now: string): string | null {
  if (task.wait_until && Date.parse(task.wait_until) <= Date.parse(now)) return 'clock';
  const since = task.wait_since_seq ?? 0;
  for (const dependencyId of task.depends_on) {
    const dependency = b.getTask(dependencyId);
    if (!dependency) continue;
    if (dependency.status !== 'done') continue;
    const events = b.store.all<Row>(
      `SELECT * FROM events WHERE task_id = ? AND type = 'task.verified' AND seq > ? ORDER BY seq ASC`,
      dependencyId,
      since,
    );
    if (events.length > 0) return 'dependency';
  }
  // A mention is a room message addressed to the assignee, with or without a
  // task id (people and assistants rarely remember to attach one).
  const roomMessages = b.store.all<Row>(
    `SELECT * FROM events WHERE room = ? AND type = 'message.posted' AND seq > ? ORDER BY seq ASC`,
    task.room,
    since,
  );
  for (const row of roomMessages) {
    const payload = JSON.parse(row['payload_json'] as string) as Record<string, unknown>;
    const to = payload['to'];
    const mentions = payload['mentions'];
    if (!task.assignee) continue;
    if (typeof to === 'string' && to === task.assignee) return 'mention';
    if (Array.isArray(mentions) && mentions.includes(task.assignee)) return 'mention';
  }
  const events = b.store.all<Row>(
    `SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq ASC`,
    task.id,
    since,
  );
  for (const row of events) {
    if (row['actor_agent'] && row['actor_agent'] !== task.assignee) return 'event';
  }
  return null;
}

export { addMinutes };
