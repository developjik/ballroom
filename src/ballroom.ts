import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Breakers, type BreakerLimits } from './breakers.js';
import { loopSignature, normalizeCommand, parseMentions } from './commands.js';
import { systemClock, type Clock } from './clock.js';
import { mapAgent, mapApproval, mapArtifact, mapEvent, mapGrant, mapRoom, mapTask, Store, type Row } from './db.js';
import { errors } from './errors.js';
import { EventLog } from './events.js';
import type {
  Agent,
  AgentKind,
  Approval,
  ApprovalDecision,
  Artifact,
  Check,
  CreateTaskInput,
  Event,
  GateCheckInput,
  GateCheckResult,
  Grant,
  GrantKind,
  Risk,
  Room,
  SignupInput,
  Task,
  TaskStatus,
  UsageReport,
} from './types.js';
import {
  addMinutes,
  normalizeScopeLock,
  randomId,
  randomToken,
  scopeLocksConflict,
  sha256,
  type Iso,
} from './util.js';
import { keeperTick, type KeeperReport } from './keeper.js';

/** Reserved actor id for the deterministic keeper in the event log. */
export const KEEPER_ACTOR = 'keeper';

export const TASK_STATUSES: TaskStatus[] = [
  'open',
  'assigned',
  'running',
  'waiting',
  'awaiting_approval',
  'blocked',
  'review',
  'done',
  'failed',
];

export const RISKS: Risk[] = ['read', 'write_local', 'irreversible', 'spend', 'outbound'];

export const CHECK_KINDS: Check['kind'][] = ['command', 'artifact', 'http', 'human', 'peer'];

const RISKY: Risk[] = ['irreversible', 'spend', 'outbound'];

const MAX_LEASE_MINUTES = 1440;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const PREVIEW_CHARS = 4096;

export interface Actor {
  owner: string;
  /** `null` means the human owner acting directly. */
  agent: string | null;
}

export interface BallroomOptions {
  /** SQLite file (':memory:' for tests). */
  dbFile?: string;
  /** Existing store, mainly for tests. */
  store?: Store;
  clock?: Clock;
  artifactsDir?: string;
  limits?: Partial<BreakerLimits>;
  /** Token the owner uses; only its hash is kept in `meta`. */
  ownerToken?: string;
  ownerId?: string;
}

export interface Inbox {
  cursor: number;
  items: Event[];
}

export interface TaskEventOptions {
  idem?: string | null;
  /** Task-scoped events advance `last_seq` unless this is false. */
  touchLastSeq?: boolean;
}

export class Ballroom {
  readonly store: Store;
  readonly clock: Clock;
  readonly log: EventLog;
  readonly breakers: Breakers;
  readonly ownerId: string;

  constructor(options: BallroomOptions = {}) {
    this.store =
      options.store ??
      new Store({
        file: options.dbFile ?? ':memory:',
        ...(options.artifactsDir ? { artifactsDir: options.artifactsDir } : {}),
      });
    this.clock = options.clock ?? systemClock;
    this.log = new EventLog(this.store);
    this.breakers = new Breakers(this.log, options.limits ?? {});
    this.ownerId = options.ownerId ?? this.store.getMeta('owner_id') ?? 'owner';
    if (options.ownerToken) this.setOwnerToken(options.ownerToken);
    this.store.setMeta('owner_id', this.ownerId);
  }

  // ---------------------------------------------------------------- time

  now(): Date {
    return this.clock.now();
  }

  nowIso(): Iso {
    return this.now().toISOString();
  }

  // -------------------------------------------------------------- rooms

  createRoom(input: {
    room?: string;
    owner?: string;
    unattended?: boolean;
    autodispatch?: boolean;
    approval_ttl_minutes?: number;
    daily_budget_tokens: number;
  }): Room {
    const now = this.nowIso();
    const name = (input.room ?? 'main').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
      throw errors.badRequest('room must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}', { room: name });
    }
    if (this.store.one('SELECT room FROM rooms WHERE room = ?', name)) {
      throw errors.badRequest('room already exists', { room: name });
    }
    if (!Number.isInteger(input.daily_budget_tokens) || input.daily_budget_tokens <= 0) {
      // "일 예산에는 기본값이 없다. 방을 만들 때 반드시 입력한다." (SPEC §6.6)
      throw errors.badRequest('daily_budget_tokens is required and must be a positive integer');
    }
    const owner = input.owner ?? this.ownerId;
    this.store.run(
      `INSERT INTO rooms(room, owner, unattended, autodispatch, approval_ttl_minutes, daily_budget_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      name,
      owner,
      input.unattended ? 1 : 0,
      input.autodispatch === false ? 0 : 1,
      input.approval_ttl_minutes ?? 1440,
      input.daily_budget_tokens,
      now,
    );
    this.log.append({
      room: name,
      type: 'room.created',
      ts: now,
      actor_owner: owner,
      actor_agent: null,
      payload: { unattended: !!input.unattended, daily_budget_tokens: input.daily_budget_tokens },
    });
    return this.requireRoom(name);
  }

  requireRoom(room: string): Room {
    const row = this.store.one<Row>('SELECT * FROM rooms WHERE room = ?', room);
    if (!row) throw errors.notFound(`room ${room}`);
    return mapRoom(row);
  }

  listRooms(): Room[] {
    return this.store.all<Row>('SELECT * FROM rooms ORDER BY created_at ASC').map(mapRoom);
  }

  /** Owner token check; the token itself is never stored. */
  isOwnerToken(token: string): boolean {
    const hash = this.store.getMeta('owner_token_hash');
    if (!hash) return false;
    return sha256(`owner:${token}`) === hash;
  }

  setOwnerToken(token: string): void {
    this.store.setMeta('owner_token_hash', sha256(`owner:${token}`));
  }

  hasOwnerToken(): boolean {
    return this.store.getMeta('owner_token_hash') !== null;
  }

  // ------------------------------------------------------------- agents

  signup(input: SignupInput): { agent: Agent; key: string; confirm_token: string } {
    const room = this.requireRoom(input.room);
    const handle = (input.name ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(handle)) {
      throw errors.badRequest('agent name must match [a-z0-9][a-z0-9._-]{1,63}');
    }
    if (this.store.one('SELECT id FROM agents WHERE id = ?', handle)) {
      throw errors.badRequest('agent name already taken', { agent: handle });
    }
    const kind: AgentKind = input.kind ?? 'cli';
    if (!['cli', 'hosted', 'human'].includes(kind)) {
      throw errors.badRequest('kind must be cli, hosted or human');
    }
    const now = this.nowIso();
    const key = `br_${handle}_${randomToken(18)}`;
    const confirmToken = randomToken(18);
    this.store.run(
      `INSERT INTO agents(id, owner, room, kind, participate, wake, gate, approval_delegated, status,
                          key_hash, confirm_token_hash, lease_default_min, stale_after_min,
                          daily_budget_tokens, last_delivered_seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 0, ?)`,
      handle,
      room.owner,
      room.room,
      kind,
      input.participate ?? (kind === 'hosted' ? 'mcp' : 'http'),
      input.wake ?? (kind === 'hosted' ? 'poll' : 'push'),
      input.gate ?? (kind === 'cli' ? 'hook' : kind === 'hosted' ? 'vendor' : 'none'),
      input.approval_delegated ? 1 : 0,
      sha256(key),
      sha256(confirmToken),
      input.lease_default_min ?? (kind === 'hosted' ? 60 : 5),
      input.stale_after_min ?? 60,
      input.daily_budget_tokens ?? null,
      now,
    );
    this.log.append({
      room: room.room,
      type: 'agent.signup',
      ts: now,
      actor_owner: room.owner,
      actor_agent: handle,
      payload: { kind, pending: true },
    });
    return { agent: this.requireAgent(handle), key, confirm_token: confirmToken };
  }

  confirmAgent(agentId: string, confirmToken: string): Agent {
    const agent = this.requireAgent(agentId);
    const row = this.store.one<{ confirm_token_hash: string | null }>(
      'SELECT confirm_token_hash FROM agents WHERE id = ?',
      agentId,
    );
    if (!row?.confirm_token_hash || row.confirm_token_hash !== sha256(confirmToken)) {
      throw errors.forbidden('The confirmation token does not match.');
    }
    if (agent.status === 'active') return agent;
    const now = this.nowIso();
    this.store.run(`UPDATE agents SET status = 'active', confirm_token_hash = NULL WHERE id = ?`, agentId);
    this.log.append({
      room: agent.room,
      type: 'agent.confirmed',
      ts: now,
      actor_owner: agent.owner,
      actor_agent: agentId,
      payload: {},
    });
    return this.requireAgent(agentId);
  }

  requireAgent(agentId: string): Agent {
    const row = this.store.one<Row>('SELECT * FROM agents WHERE id = ?', agentId);
    if (!row) throw errors.notFound(`agent ${agentId}`);
    return mapAgent(row);
  }

  listAgents(room: string): Agent[] {
    return this.store.all<Row>('SELECT * FROM agents WHERE room = ? ORDER BY id ASC', room).map(mapAgent);
  }

  /** Agent lookup by key; the DB stores only the hash. */
  agentByKey(key: string): Agent | undefined {
    const row = this.store.one<Row>('SELECT * FROM agents WHERE key_hash = ?', sha256(key));
    return row ? mapAgent(row) : undefined;
  }

  /** Bearer key → active agent. Pending keys can do nothing (SPEC §3.1). */
  authenticateAgent(key: string): Agent {
    const row = this.store.one<Row>('SELECT * FROM agents WHERE key_hash = ?', sha256(key));
    if (!row) throw errors.unauthenticated();
    const agent = mapAgent(row);
    if (agent.status !== 'active') {
      throw errors.unauthenticated('This key has not been confirmed by the owner yet.');
    }
    const now = this.nowIso();
    this.store.run('UPDATE agents SET last_seen_at = ? WHERE id = ?', now, agent.id);
    return { ...agent, last_seen_at: now };
  }

  private touch(agentId: string | null): void {
    if (!agentId || agentId === KEEPER_ACTOR) return;
    this.store.run('UPDATE agents SET last_seen_at = ? WHERE id = ?', this.nowIso(), agentId);
  }

  private assertMember(room: Room, actor: Actor): void {
    if (actor.agent === null) {
      if (actor.owner !== room.owner) throw errors.forbidden('You are not this room’s owner.');
      return;
    }
    if (actor.agent === KEEPER_ACTOR) {
      if (actor.owner !== room.owner) throw errors.forbidden('Keeper may only act for the owner.');
      return;
    }
    const agent = this.requireAgent(actor.agent);
    if (agent.room !== room.room) throw errors.forbidden('This agent belongs to another room.');
  }

  private assertAgent(actor: Actor): string {
    if (!actor.agent || actor.agent === KEEPER_ACTOR) {
      throw errors.forbidden('This action must come from an agent key.');
    }
    return actor.agent;
  }

  private assertOwnerActor(room: Room, actor: Actor): void {
    if (actor.agent !== null && actor.agent !== KEEPER_ACTOR) {
      throw errors.forbidden('The owner performs this action.');
    }
    if (actor.owner !== room.owner) throw errors.forbidden('You are not this room’s owner.');
  }

  // ------------------------------------------------------------ events

  appendEvent(input: {
    room: string;
    type: string;
    actor?: Actor;
    task_id?: string | null;
    payload?: Record<string, unknown>;
    idem_key?: string | null;
  }): Event {
    const actor = input.actor ?? { owner: this.requireRoom(input.room).owner, agent: null };
    const { event } = this.log.append({
      room: input.room,
      type: input.type,
      ts: this.nowIso(),
      actor_owner: actor.owner,
      actor_agent: actor.agent,
      task_id: input.task_id ?? null,
      payload: input.payload ?? {},
      idem_key: input.idem_key ?? null,
    });
    if (event.task_id && !event.seq) throw new Error('unreachable');
    if (event.task_id) {
      this.store.run(
        'UPDATE tasks SET last_seq = ? WHERE id = ? AND last_seq < ?',
        event.seq,
        event.task_id,
        event.seq,
      );
    }
    return event;
  }

  events(actor: Actor, room: string, after: number, limit = 200): { cursor: number; events: Event[] } {
    const r = this.requireRoom(room);
    this.assertMember(r, actor);
    this.guardCursor(room, after);
    const events = this.log.range(room, after, limit);
    const cursor = events.length > 0 ? events[events.length - 1]!.seq : this.log.maxSeq(room);
    this.markDelivered(actor.agent, cursor);
    return { cursor, events };
  }

  private guardCursor(room: string, after: number): void {
    const truncated = this.log.truncatedBefore(room);
    if (after < truncated) throw errors.snapshotRequired(this.board(room));
  }

  private markDelivered(agentId: string | null, cursor: number): void {
    if (!agentId || agentId === KEEPER_ACTOR) return;
    this.store.run(
      'UPDATE agents SET last_delivered_seq = MAX(last_delivered_seq, ?) WHERE id = ?',
      cursor,
      agentId,
    );
  }

  inboxOnce(actor: Actor, after: number, limit = 100): Inbox {
    const agentId = this.assertAgent(actor);
    const agent = this.requireAgent(agentId);
    const room = this.requireRoom(agent.room);
    this.guardCursor(room.room, after);
    const events = this.log.range(room.room, after, limit);
    const items = events.filter((event) => this.isInboxItem(agent, event));
    const cursor = events.length > 0 ? events[events.length - 1]!.seq : this.log.maxSeq(room.room);
    this.markDelivered(agent.id, cursor);
    return { cursor, items };
  }

  private isInboxItem(agent: Agent, event: Event): boolean {
    if (event.actor_agent === agent.id) return false;
    if (event.task_id) {
      const row = this.store.one<Row>('SELECT * FROM tasks WHERE id = ?', event.task_id);
      if (row) {
        const task = mapTask(row);
        if (task.assignee === agent.id || task.created_by === agent.id) return true;
      }
    }
    const to = event.payload['to'];
    if (typeof to === 'string' && (to === agent.id || to === 'room')) return true;
    const mentions = event.payload['mentions'];
    if (Array.isArray(mentions) && mentions.includes(agent.id)) return true;
    return false;
  }

  // ------------------------------------------------------------- tasks

  createTask(actor: Actor, room: string, input: CreateTaskInput): Task {
    const r = this.requireRoom(room);
    this.assertMember(r, actor);
    const title = (input.title ?? '').trim();
    if (!title) throw errors.badRequest('title is required');
    const risk = input.risk ?? 'write_local';
    if (!RISKS.includes(risk)) throw errors.badRequest(`risk must be one of ${RISKS.join(', ')}`);
    const check = validateCheck(input.check);
    if (r.unattended && check.kind === 'human') {
      // An unattended room cannot wait for a human; refuse at the source.
      throw errors.badRequest(
        'This room is unattended: a task with check.kind = "human" would stall the chain.',
        { check },
      );
    }
    const idem = input.idem_key ?? null;
    if (idem) {
      const existing = this.store.one<Row>(
        `SELECT task_id FROM events WHERE room = ? AND actor_agent IS ? AND idem_key = ?`,
        room,
        actor.agent,
        idem,
      );
      if (existing?.task_id) return this.requireTask(existing.task_id as string);
    }
    const now = this.nowIso();
    const id = randomId('task', 8);
    const assignee = input.assignee ?? null;
    if (assignee) {
      const agent = this.requireAgent(assignee);
      if (agent.room !== room) throw errors.badRequest('assignee belongs to another room');
      if (!agentCanTake(agent, { kind: input.kind ?? 'general', risk })) {
        throw errors.badRequest('assignee is not capable of this kind/risk', { assignee });
      }
    }
    const task: Task = {
      id,
      room,
      title,
      body_md: input.body_md ?? '',
      kind: input.kind ?? 'general',
      priority: input.priority ?? 0,
      risk,
      status: assignee ? 'assigned' : 'open',
      version: 1,
      last_seq: 0,
      assignee,
      assigned_at: assignee ? now : null,
      lease_until: null,
      attempt: 0,
      scope_lock: normalizeScopeLock(input.scope_lock ?? null),
      wait_reason: null,
      wait_until: null,
      wait_since_seq: null,
      parent_id: input.parent_id ?? null,
      depends_on: input.depends_on ?? [],
      budget_turns: input.budget_turns ?? 12,
      budget_tokens: input.budget_tokens ?? null,
      turns_used: 0,
      tokens_used: 0,
      resume_note_md: null,
      check,
      proof: null,
      verify: 'none',
      verified_by: null,
      created_by: actor.agent ?? actor.owner,
      created_at: now,
      updated_at: now,
    };
    this.persistNewTask(task);
    this.appendEvent({
      room,
      type: 'task.created',
      actor,
      task_id: id,
      payload: { risk, kind: task.kind, check, scope_lock: task.scope_lock, assignee },
      idem_key: idem,
    });
    return this.requireTask(id);
  }

  private persistNewTask(task: Task): void {
    this.store.run(
      `INSERT INTO tasks(id, room, title, body_md, kind, priority, risk, status, version, last_seq,
                         assignee, assigned_at, lease_until, attempt, scope_lock, wait_reason,
                         wait_until, wait_since_seq, parent_id, depends_on_json, budget_turns,
                         budget_tokens, turns_used, tokens_used, resume_note_md, check_json,
                         proof_json, verify, verified_by, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id,
      task.room,
      task.title,
      task.body_md,
      task.kind,
      task.priority,
      task.risk,
      task.status,
      task.version,
      task.last_seq,
      task.assignee,
      task.assigned_at,
      task.lease_until,
      task.attempt,
      task.scope_lock,
      task.wait_reason,
      task.wait_until,
      task.wait_since_seq,
      task.parent_id,
      JSON.stringify(task.depends_on),
      task.budget_turns,
      task.budget_tokens,
      task.turns_used,
      task.tokens_used,
      task.resume_note_md,
      JSON.stringify(task.check),
      task.proof === null ? null : JSON.stringify(task.proof),
      task.verify,
      task.verified_by,
      task.created_by,
      task.created_at,
      task.updated_at,
    );
  }

  private persistTask(next: Task, expectedVersion: number): void {
    const info = this.store.run(
      `UPDATE tasks SET title = ?, body_md = ?, kind = ?, priority = ?, risk = ?, status = ?,
                        version = ?, last_seq = ?, assignee = ?, assigned_at = ?, lease_until = ?,
                        attempt = ?, scope_lock = ?, wait_reason = ?, wait_until = ?,
                        wait_since_seq = ?, parent_id = ?, depends_on_json = ?, budget_turns = ?,
                        budget_tokens = ?, turns_used = ?, tokens_used = ?, resume_note_md = ?,
                        check_json = ?, proof_json = ?, verify = ?, verified_by = ?, created_by = ?,
                        created_at = ?, updated_at = ?
       WHERE id = ? AND version = ?`,
      next.title,
      next.body_md,
      next.kind,
      next.priority,
      next.risk,
      next.status,
      next.version,
      next.last_seq,
      next.assignee,
      next.assigned_at,
      next.lease_until,
      next.attempt,
      next.scope_lock,
      next.wait_reason,
      next.wait_until,
      next.wait_since_seq,
      next.parent_id,
      JSON.stringify(next.depends_on),
      next.budget_turns,
      next.budget_tokens,
      next.turns_used,
      next.tokens_used,
      next.resume_note_md,
      JSON.stringify(next.check),
      next.proof === null ? null : JSON.stringify(next.proof),
      next.verify,
      next.verified_by,
      next.created_by,
      next.created_at,
      next.updated_at,
      next.id,
      expectedVersion,
    );
    if (info.changes !== 1) throw errors.versionConflict(this.getTask(next.id));
  }

  requireTask(taskId: string): Task {
    const row = this.store.one<Row>('SELECT * FROM tasks WHERE id = ?', taskId);
    if (!row) throw errors.notFound(`task ${taskId}`);
    return mapTask(row);
  }

  getTask(taskId: string): Task | undefined {
    const row = this.store.one<Row>('SELECT * FROM tasks WHERE id = ?', taskId);
    return row ? mapTask(row) : undefined;
  }

  listTasks(room: string): Task[] {
    return this.store
      .all<Row>(
        `SELECT * FROM tasks WHERE room = ?
         ORDER BY CASE status
           WHEN 'running' THEN 0 WHEN 'awaiting_approval' THEN 1 WHEN 'blocked' THEN 2
           WHEN 'review' THEN 3 WHEN 'assigned' THEN 4 WHEN 'waiting' THEN 5
           WHEN 'open' THEN 6 WHEN 'done' THEN 7 ELSE 8 END,
         priority DESC, created_at ASC`,
        room,
      )
      .map(mapTask);
  }

  /** One transition: version CAS + event + `last_seq` in a single writer. */
  mutate(
    actor: Actor,
    task: Task,
    patch: Partial<Task>,
    type: string,
    payload: Record<string, unknown> = {},
    options: TaskEventOptions = {},
  ): Task {
    const now = this.nowIso();
    const next: Task = { ...task, ...patch, version: task.version + 1, updated_at: now };
    this.persistTask(next, task.version);
    const room = this.requireRoom(task.room);
    const actorForEvent = actor.agent === null ? { owner: room.owner, agent: null } : actor;
    const { event } = this.log.append({
      room: task.room,
      type,
      ts: now,
      actor_owner: actorForEvent.owner,
      actor_agent: actorForEvent.agent,
      task_id: task.id,
      payload: { task_version: next.version, status: next.status, ...payload },
      idem_key: options.idem ?? null,
    });
    if (options.touchLastSeq !== false) {
      this.store.run(
        'UPDATE tasks SET last_seq = ? WHERE id = ? AND last_seq < ?',
        event.seq,
        task.id,
        event.seq,
      );
      return { ...next, last_seq: event.seq };
    }
    return next;
  }

  private checkVersion(task: Task, version: number | undefined): void {
    if (version === undefined || version === null) {
      throw errors.badRequest('version is required (optimistic concurrency)');
    }
    if (version !== task.version) throw errors.versionConflict(task);
  }

  private requireStatus(task: Task, ...allowed: TaskStatus[]): void {
    if (!allowed.includes(task.status)) throw errors.conflictState(task.status, allowed);
  }

  private requireAssignee(task: Task, agentId: string): void {
    if (task.assignee !== agentId) {
      throw errors.forbidden(`This task is assigned to ${task.assignee ?? 'nobody'}.`);
    }
  }

  claim(actor: Actor, taskId: string, input: { version?: number; lease_minutes?: number }): Task {
    const agentId = this.assertAgent(actor);
    this.touch(agentId);
    return this.store.immediate(() => {
      const task = this.requireTask(taskId);
      const room = this.requireRoom(task.room);
      this.assertMember(room, actor);
      this.requireStatus(task, 'open', 'assigned');
      if (task.status === 'assigned' && task.assignee && task.assignee !== agentId) {
        throw errors.alreadyClaimed(task.assignee, task);
      }
      this.checkVersion(task, input.version);
      const agent = this.requireAgent(agentId);
      if (agent.room !== room.room) throw errors.forbidden('This agent belongs to another room.');
      if (!agentCanTake(agent, task)) {
        throw errors.forbidden('This agent is not capable of the task’s kind/risk.');
      }
      const conflict = this.scopeConflict(task);
      if (conflict) throw errors.scopeLocked(conflict);
      const leaseMinutes = clamp(input.lease_minutes ?? agent.lease_default_min, 1, MAX_LEASE_MINUTES);
      const now = this.nowIso();
      return this.mutate(
        actor,
        task,
        {
          status: 'running',
          assignee: agentId,
          assigned_at: task.assignee === agentId && task.assigned_at ? task.assigned_at : now,
          lease_until: addMinutes(now, leaseMinutes),
          wait_reason: null,
          wait_until: null,
          wait_since_seq: null,
        },
        'task.claimed',
        { lease_minutes: leaseMinutes },
      );
    });
  }

  /** Running tasks that hold a conflicting scope lock. */
  scopeConflict(task: Task): Task | null {
    if (!task.scope_lock) return null;
    const others = this.store.all<Row>(
      `SELECT * FROM tasks WHERE room = ? AND status = 'running' AND id <> ?`,
      task.room,
      task.id,
    );
    for (const row of others) {
      const other = mapTask(row);
      if (scopeLocksConflict(task.scope_lock, other.scope_lock)) return other;
    }
    return null;
  }

  renew(actor: Actor, taskId: string, input: { lease_minutes?: number }): Task {
    const agentId = this.assertAgent(actor);
    this.touch(agentId);
    return this.store.immediate(() => {
      const task = this.requireTask(taskId);
      this.assertMember(this.requireRoom(task.room), actor);
      this.requireStatus(task, 'running');
      this.requireAssignee(task, agentId);
      const agent = this.requireAgent(agentId);
      const minutes = clamp(input.lease_minutes ?? agent.lease_default_min, 1, MAX_LEASE_MINUTES);
      const leaseUntil = addMinutes(this.nowIso(), minutes);
      return this.mutate(actor, task, { lease_until: leaseUntil }, 'task.lease_renewed', {
        lease_minutes: minutes,
        lease_until: leaseUntil,
      });
    });
  }

  wait(
    actor: Actor,
    taskId: string,
    input: { version?: number; reason: string; until?: string; resume_note: string },
  ): Task {
    const agentId = this.assertAgent(actor);
    this.touch(agentId);
    return this.store.immediate(() => {
      const task = this.requireTask(taskId);
      this.assertMember(this.requireRoom(task.room), actor);
      this.requireStatus(task, 'running');
      this.requireAssignee(task, agentId);
      this.checkVersion(task, input.version);
      if (!input.resume_note || input.resume_note.trim() === '') {
        throw errors.badRequest('resume_note is required when a task starts waiting');
      }
      if (!input.reason || input.reason.trim() === '') {
        throw errors.badRequest('reason is required');
      }
      return this.mutate(
        actor,
        task,
        {
          status: 'waiting',
          lease_until: null,
          wait_reason: input.reason,
          wait_until: input.until ?? null,
          wait_since_seq: task.last_seq,
          resume_note_md: input.resume_note,
        },
        'task.waiting',
        { reason: input.reason, until: input.until ?? null },
      );
    });
  }

  complete(
    actor: Actor,
    taskId: string,
    input: { version?: number; read_seq: number; proof: unknown },
  ): Task {
    const agentId = this.assertAgent(actor);
    this.touch(agentId);
    return this.store.immediate(() => {
      const task = this.requireTask(taskId);
      this.assertMember(this.requireRoom(task.room), actor);
      this.requireStatus(task, 'running', 'assigned');
      this.requireAssignee(task, agentId);
      this.checkVersion(task, input.version);
      if (input.proof === undefined || input.proof === null) {
        throw errors.badRequest('proof is required to complete a task');
      }
      if (typeof input.read_seq !== 'number') {
        throw errors.badRequest('read_seq is required (confirm guard)');
      }
      if (input.read_seq < task.last_seq) {
        // Confirm guard: refuse to confirm work whose events were never read.
        const unread = this.log.forTask(task.id, input.read_seq);
        throw errors.unreadEvents(unread);
      }
      return this.mutate(
        actor,
        task,
        { status: 'review', lease_until: null, proof: input.proof, verify: 'none' },
        'task.completed',
        { read_seq: input.read_seq },
      );
    });
  }

  verify(
    actor: Actor,
    taskId: string,
    input: { result: 'passed' | 'rejected' | 'human_confirmed' | 'abort'; evidence?: unknown },
  ): Task {
    return this.store.immediate(() => {
      const task = this.requireTask(taskId);
      const room = this.requireRoom(task.room);
      this.assertMember(room, actor);
      this.requireStatus(task, 'review');
      if (
        actor.agent &&
        actor.agent !== KEEPER_ACTOR &&
        actor.agent === task.assignee
      ) {
        throw errors.forbidden('The assignee cannot verify their own work.');
      }
      if (!['passed', 'rejected', 'human_confirmed', 'abort'].includes(input.result)) {
        throw errors.badRequest('result must be passed, rejected, human_confirmed or abort');
      }
      const now = this.nowIso();
      const evidence = input.evidence ?? null;
      if (input.result === 'passed' || input.result === 'human_confirmed') {
        return this.mutate(
          actor,
          task,
          {
            status: 'done',
            verify: input.result,
            verified_by: actor.agent ?? actor.owner,
            attempt: 0,
            lease_until: null,
          },
          'task.verified',
          { result: input.result, evidence },
        );
      }
      if (input.result === 'abort') {
        return this.mutate(
          actor,
          task,
          { status: 'failed', verify: 'rejected', verified_by: actor.agent ?? actor.owner },
          'task.verified',
          { result: 'abort', evidence },
        );
      }
      // rejected: count the failure; two in a row put the task back in the pool.
      const attempt = task.attempt + 1;
      const exhausted = attempt >= 2;
      return this.mutate(
        actor,
        task,
        {
          status: exhausted ? 'open' : 'assigned',
          verify: 'rejected',
          verified_by: actor.agent ?? actor.owner,
          attempt,
          assignee: exhausted ? null : task.assignee,
          assigned_at: exhausted ? null : now,
          lease_until: null,
        },
        'task.verified',
        { result: 'rejected', evidence, attempt, exhausted },
      );
    });
  }

  handoff(actor: Actor, taskId: string, input: { version?: number; to: string }): Task {
    const agentId = this.assertAgent(actor);
    this.touch(agentId);
    return this.store.immediate(() => {
      const task = this.requireTask(taskId);
      const room = this.requireRoom(task.room);
      this.assertMember(room, actor);
      this.requireStatus(task, 'assigned', 'running');
      this.requireAssignee(task, agentId);
      this.checkVersion(task, input.version);
      if (!input.to || input.to === agentId) throw errors.badRequest('handoff target must be another agent');
      const target = this.requireAgent(input.to);
      if (target.room !== room.room) throw errors.badRequest('target belongs to another room');
      if (!agentCanTake(target, task)) {
        throw errors.badRequest('target is not capable of this kind/risk', { to: input.to });
      }
      return this.mutate(
        actor,
        task,
        { status: 'assigned', assignee: target.id, assigned_at: this.nowIso(), lease_until: null },
        'task.handoff',
        { from: agentId, to: target.id },
      );
    });
  }

  release(actor: Actor, taskId: string, input: { version?: number }): Task {
    const agentId = this.assertAgent(actor);
    this.touch(agentId);
    return this.store.immediate(() => {
      const task = this.requireTask(taskId);
      this.assertMember(this.requireRoom(task.room), actor);
      this.requireStatus(task, 'assigned', 'running');
      this.requireAssignee(task, agentId);
      this.checkVersion(task, input.version);
      return this.mutate(
        actor,
        task,
        { status: 'open', assignee: null, assigned_at: null, lease_until: null },
        'task.released',
      );
    });
  }

  block(actor: Actor, taskId: string, input: { version?: number; reason: string }): Task {
    return this.store.immediate(() => {
      const task = this.requireTask(taskId);
      const room = this.requireRoom(task.room);
      this.assertMember(room, actor);
      this.requireStatus(task, 'assigned', 'running', 'waiting', 'awaiting_approval', 'review');
      const isKeeper = actor.agent === KEEPER_ACTOR;
      if (!isKeeper && actor.agent) {
        if (actor.agent !== task.assignee) {
          throw errors.forbidden('Only the assignee or the owner can block a task.');
        }
        this.touch(actor.agent);
      }
      if (!input.reason) throw errors.badRequest('reason is required');
      return this.mutate(
        actor,
        task,
        { status: 'blocked', lease_until: null, wait_reason: null, wait_until: null },
        'task.blocked',
        { reason: input.reason },
      );
    });
  }

  resolve(actor: Actor, taskId: string, input: { version?: number; assignee?: string | null }): Task {
    return this.store.immediate(() => {
      const task = this.requireTask(taskId);
      const room = this.requireRoom(task.room);
      this.assertOwnerActor(room, actor);
      this.requireStatus(task, 'blocked');
      this.checkVersion(task, input.version);
      const assignee = input.assignee ?? null;
      if (assignee) {
        const target = this.requireAgent(assignee);
        if (target.room !== room.room) throw errors.badRequest('assignee belongs to another room');
      }
      return this.mutate(
        actor,
        task,
        assignee
          ? { status: 'assigned', assignee, assigned_at: this.nowIso(), wait_reason: null }
          : { status: 'open', assignee: null, assigned_at: null, wait_reason: null },
        'task.resolved',
        { assignee },
      );
    });
  }

  assign(actor: Actor, taskId: string, input: { version?: number; agent: string }): Task {
    return this.store.immediate(() => {
      const task = this.requireTask(taskId);
      const room = this.requireRoom(task.room);
      this.assertMember(room, actor);
      const isOwner = actor.agent === null;
      const isKeeper = actor.agent === KEEPER_ACTOR;
      if (!isOwner && !isKeeper) throw errors.forbidden('Only the owner or keeper can assign.');
      this.requireStatus(task, 'open');
      this.checkVersion(task, input.version);
      const target = this.requireAgent(input.agent);
      if (target.room !== room.room) throw errors.badRequest('agent belongs to another room');
      if (!agentCanTake(target, task)) {
        throw errors.badRequest('agent is not capable of this kind/risk', { agent: input.agent });
      }
      return this.mutate(
        actor,
        task,
        { status: 'assigned', assignee: target.id, assigned_at: this.nowIso(), lease_until: null },
        'task.assigned',
        { by: isKeeper ? 'keeper' : 'owner', agent: target.id },
        isKeeper ? { idem: `keeper:assign:${task.id}:${task.version}` } : {},
      );
    });
  }

  // ---------------------------------------------------------- messages

  postMessage(
    actor: Actor,
    room: string,
    input: { task?: string | null; content: string; idem_key: string; to?: string | null },
  ): { seq: number; mentions: string[]; duplicate: boolean } {
    const agentId = this.assertAgent(actor);
    const r = this.requireRoom(room);
    this.assertMember(r, actor);
    if (!input.idem_key) throw errors.badRequest('idem_key is required for writes');
    const content = input.content ?? '';
    if (content.trim() === '') throw errors.badRequest('content is required');
    const now = this.nowIso();

    type Outcome =
      | { ok: true; seq: number; mentions: string[]; duplicate: boolean }
      | { ok: false; error: unknown };

    const outcome = this.store.immediate((): Outcome => {
      const existing = this.store.one<Row>(
        `SELECT * FROM events WHERE room = ? AND actor_agent = ? AND idem_key = ?`,
        room,
        agentId,
        input.idem_key,
      );
      if (existing) {
        const event = mapEvent(existing);
        const mentions = Array.isArray(event.payload['mentions']) ? (event.payload['mentions'] as string[]) : [];
        return { ok: true, seq: event.seq, mentions, duplicate: true };
      }
      const task = input.task ? this.requireTask(input.task) : null;
      if (task && task.room !== room) throw errors.badRequest('task belongs to another room');
      const known = this.listAgents(room).map((a) => a.id);
      const to = input.to ?? null;
      if (to && to !== 'room' && !known.includes(to)) throw errors.badRequest('unknown recipient', { to });
      const mentions = parseMentions(content, known);
      const signature = loopSignature({
        sender: agentId,
        recipient: to,
        content,
        taskId: task?.id ?? null,
      });
      try {
        this.breakers.checkRate(room, agentId, now);
        this.breakers.checkLoop(room, signature, now);
      } catch (error) {
        const bucket = new Date(Date.parse(now)).toISOString().slice(0, 16);
        this.appendEvent({
          room,
          type: 'breaker.tripped',
          actor,
          task_id: task?.id ?? null,
          payload: {
            code: (error as { code?: string }).code ?? 'breaker',
            signature: (error as { code?: string }).code === 'loop_detected' ? signature : null,
          },
          idem_key: `breaker:${(error as { code?: string }).code}:${agentId}:${signature}:${bucket}`,
        });
        return { ok: false, error };
      }
      const info = this.store.run(
        `INSERT INTO events(room, type, actor_owner, actor_agent, task_id, payload_json, ts, idem_key)
         VALUES (?, 'message.posted', ?, ?, ?, ?, ?, ?)`,
        room,
        r.owner,
        agentId,
        task?.id ?? null,
        JSON.stringify({ content, to, mentions, signature }),
        now,
        input.idem_key,
      );
      const seq = Number(info.lastInsertRowid);
      if (task) {
        this.store.run(
          'UPDATE tasks SET last_seq = ? WHERE id = ? AND last_seq < ?',
          seq,
          task.id,
          seq,
        );
      }
      return { ok: true, seq, mentions, duplicate: false };
    });

    if (!outcome.ok) throw outcome.error;
    return { seq: outcome.seq, mentions: outcome.mentions, duplicate: outcome.duplicate };
  }

  // ------------------------------------------------------ gate/approval

  gateCheck(actor: Actor, input: GateCheckInput): GateCheckResult {
    const agentId = this.assertAgent(actor);
    this.touch(agentId);

    type Outcome =
      | GateCheckResult
      | { status: -1; budget: { scope: string; task: Task; code: string } };

    const outcome = this.store.immediate((): Outcome => {
      const task = this.requireTask(input.task);
      const room = this.requireRoom(task.room);
      this.assertMember(room, actor);
      if (task.assignee !== agentId) {
        throw errors.forbidden('Only the assignee can ask for a gate decision.');
      }
      if (task.status === 'done' || task.status === 'failed') {
        throw errors.conflictState(task.status, ['running', 'awaiting_approval']);
      }
      if (!input.action_hash) throw errors.badRequest('action_hash is required');
      const normalized = input.command ? normalizeCommand(input.command) : null;

      // Confirm guard for hooks: the hook cannot know what the model read, so
      // the room compares what it delivered with the task’s latest event.
      const agent = this.requireAgent(agentId);
      if (agent.last_delivered_seq < task.last_seq) {
        return {
          status: 409,
          allow: false,
          code: 'unread_events',
          unread_events: this.log.forTask(task.id, agent.last_delivered_seq),
          task,
        };
      }

      const grant = this.findGrant(task, agentId, input, normalized);
      if (grant) {
        this.store.run(
          'UPDATE grants SET uses_left = uses_left - 1, used_at = ? WHERE id = ?',
          this.nowIso(),
          grant.id,
        );
        this.appendEvent({
          room: task.room,
          type: 'grant.consumed',
          actor,
          task_id: task.id,
          payload: {
            grant_id: grant.id,
            kind: grant.kind,
            normalized_command: normalized,
            action_hash: input.action_hash,
          },
        });
        return {
          status: 200,
          allow: true,
          grant: { id: grant.id, kind: grant.kind },
          task: this.requireTask(task.id),
        };
      }

      const pending = this.store.one<Row>(
        `SELECT * FROM approvals WHERE task_id = ? AND agent_id = ? AND action_hash = ? AND status = 'pending'`,
        task.id,
        agentId,
        input.action_hash,
      );
      if (pending) {
        return { status: 428, allow: false, approval_id: pending['id'] as string, task };
      }

      const now = this.nowIso();
      const expires = addMinutes(now, room.approval_ttl_minutes);
      const id = randomId('apr', 8);
      this.store.run(
        `INSERT INTO approvals(id, room, task_id, agent_id, status, risk, action_hash,
                               normalized_command, preview, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
        id,
        task.room,
        task.id,
        agentId,
        input.risk ?? task.risk,
        input.action_hash,
        normalized,
        input.preview?.slice(0, 2000) ?? null,
        now,
        expires,
      );
      // One approval request costs one turn of the task budget (SPEC §6.5), so
      // an approval ping-pong eventually stops on its own.
      const turns = task.turns_used + 1;
      if (task.budget_turns > 0 && turns > task.budget_turns) {
        const blocked = this.mutate(
          { owner: room.owner, agent: KEEPER_ACTOR },
          task,
          { status: 'blocked', turns_used: turns, lease_until: null },
          'task.blocked',
          { reason: 'budget', scope: 'task.turns', approval_id: id },
        );
        return { status: -1, budget: { scope: 'task.turns', task: blocked, code: 'budget_exhausted' } };
      }
      this.mutate(
        { owner: room.owner, agent: KEEPER_ACTOR },
        task,
        { status: 'awaiting_approval', turns_used: turns, lease_until: null },
        'task.gate',
        {
          approval_id: id,
          action_hash: input.action_hash,
          normalized_command: normalized,
          risk: input.risk ?? task.risk,
        },
      );
      this.appendEvent({
        room: task.room,
        type: 'approval.created',
        actor,
        task_id: task.id,
        payload: {
          approval_id: id,
          action_hash: input.action_hash,
          normalized_command: normalized,
          expires_at: expires,
        },
      });
      return { status: 428, allow: false, approval_id: id, task: this.requireTask(task.id) };
    });

    if ('budget' in outcome) {
      throw errors.budgetExhausted(outcome.budget.scope, { task: outcome.budget.task });
    }
    return outcome;
  }

  private findGrant(
    task: Task,
    agentId: string,
    input: GateCheckInput,
    normalized: string | null,
  ): Grant | null {
    const rows = this.store.all<Row>(
      `SELECT * FROM grants WHERE task_id = ? AND agent_id = ? AND uses_left > 0 AND expires_at > ?
       ORDER BY CASE kind WHEN 'action_hash' THEN 0 WHEN 'normalized' THEN 1 WHEN 'pattern' THEN 2 ELSE 3 END`,
      task.id,
      agentId,
      this.nowIso(),
    );
    const grants = rows.map(mapGrant);
    const exactHash = grants.find((g) => g.kind === 'action_hash' && g.action_hash === input.action_hash);
    if (exactHash) return exactHash;
    if (normalized) {
      const exact = grants.find((g) => g.kind === 'normalized' && g.normalized_command === normalized);
      if (exact) return exact;
      for (const grant of grants) {
        if (grant.kind !== 'pattern' || !grant.pattern) continue;
        try {
          if (new RegExp(grant.pattern).test(normalized)) return grant;
        } catch {
          if (grant.pattern === normalized) return grant;
        }
      }
    }
    if (input.executor === 'runner') {
      const runner = grants.find((g) => g.kind === 'runner_exec');
      if (runner) return runner;
    }
    return null;
  }

  approvalById(id: string): Approval {
    const row = this.store.one<Row>('SELECT * FROM approvals WHERE id = ?', id);
    if (!row) throw errors.notFound(`approval ${id}`);
    return mapApproval(row);
  }

  listApprovals(room: string, status?: string): Approval[] {
    const rows = status
      ? this.store.all<Row>(
          'SELECT * FROM approvals WHERE room = ? AND status = ? ORDER BY created_at ASC',
          room,
          status,
        )
      : this.store.all<Row>('SELECT * FROM approvals WHERE room = ? ORDER BY created_at ASC', room);
    return rows.map(mapApproval);
  }

  decideApproval(
    actor: Actor,
    approvalId: string,
    decision: ApprovalDecision,
  ): { approval: Approval; grant: Grant | null; task: Task } {
    return this.store.immediate(() => {
      const approval = this.approvalById(approvalId);
      const room = this.requireRoom(approval.room);
      this.assertOwnerActor(room, actor);
      if (approval.status !== 'pending') {
        throw errors.badRequest(`This approval is already ${approval.status}.`);
      }
      const now = this.nowIso();
      const task = this.requireTask(approval.task_id);
      if (decision.decision === 'deny') {
        this.store.run(
          `UPDATE approvals SET status = 'denied', decided_at = ?, decided_by = ?, note = ? WHERE id = ?`,
          now,
          actor.owner,
          decision.note ?? null,
          approval.id,
        );
        const blockedTask = this.mutate(
          actor,
          task,
          { status: 'blocked', lease_until: null },
          'task.blocked',
          { reason: 'approval_denied', approval_id: approval.id },
        );
        this.appendEvent({
          room: approval.room,
          type: 'approval.decided',
          actor,
          task_id: task.id,
          payload: { approval_id: approval.id, decision: 'deny', note: decision.note ?? null },
        });
        return { approval: this.approvalById(approval.id), grant: null, task: blockedTask };
      }

      this.store.run(
        `UPDATE approvals SET status = 'approved', decided_at = ?, decided_by = ?, note = ? WHERE id = ?`,
        now,
        actor.owner,
        decision.note ?? null,
        approval.id,
      );
      const kind = grantKindFor(decision, approval);
      if (kind === 'pattern' && !decision.pattern) {
        throw errors.badRequest('pattern is required for a pattern grant');
      }
      const ttl = Math.min(decision.ttl_seconds ?? 1800, 24 * 3600);
      const candidate = new Date(Date.parse(now) + ttl * 1000).toISOString();
      const expiresAt = Date.parse(candidate) < Date.parse(approval.expires_at) ? candidate : approval.expires_at;
      const grant: Grant = {
        id: randomId('grt', 8),
        room: approval.room,
        task_id: approval.task_id,
        agent_id: approval.agent_id,
        approval_id: approval.id,
        kind,
        action_hash: kind === 'action_hash' ? approval.action_hash : null,
        normalized_command: kind === 'normalized' ? approval.normalized_command : null,
        pattern: kind === 'pattern' ? (decision.pattern ?? null) : null,
        uses_left: 1,
        expires_at: expiresAt,
        created_at: now,
        used_at: null,
      };
      this.store.run(
        `INSERT INTO grants(id, room, task_id, agent_id, approval_id, kind, action_hash,
                            normalized_command, pattern, uses_left, expires_at, created_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
        grant.id,
        grant.room,
        grant.task_id,
        grant.agent_id,
        grant.approval_id,
        grant.kind,
        grant.action_hash,
        grant.normalized_command,
        grant.pattern,
        grant.expires_at,
        grant.created_at,
      );
      const resumeNote = approval.normalized_command
        ? `Approval granted (one use): ${approval.normalized_command}`
        : `Approval granted (one use) for action ${approval.action_hash}`;
      const nextTask = this.mutate(
        actor,
        task,
        {
          status: task.status === 'awaiting_approval' ? 'assigned' : task.status,
          resume_note_md: resumeNote,
          lease_until: null,
        },
        'task.approval_decided',
        { approval_id: approval.id, decision: 'approve', grant_id: grant.id, kind },
      );
      this.appendEvent({
        room: approval.room,
        type: 'grant.created',
        actor,
        task_id: task.id,
        payload: {
          grant_id: grant.id,
          approval_id: approval.id,
          kind,
          normalized_command: grant.normalized_command,
          pattern: grant.pattern,
          expires_at: grant.expires_at,
        },
      });
      return { approval: this.approvalById(approval.id), grant, task: nextTask };
    });
  }

  // ------------------------------------------------------------- usage

  reportUsage(actor: Actor, report: UsageReport): { task: Task; agent_tokens_today: number } {
    const agentId = this.assertAgent(actor);
    this.touch(agentId);

    type Outcome =
      | { ok: true; task: Task; agent_tokens_today: number }
      | { ok: false; scope: string; task: Task };

    const outcome = this.store.immediate((): Outcome => {
      const task = this.requireTask(report.task);
      const room = this.requireRoom(task.room);
      this.assertMember(room, actor);
      this.requireAssignee(task, agentId);
      const turns = Math.max(0, Math.trunc(report.turns ?? 0));
      const tokensIn = Math.max(0, Math.trunc(report.tokens_in ?? 0));
      const tokensOut = Math.max(0, Math.trunc(report.tokens_out ?? 0));
      const now = this.nowIso();
      const turnsUsed = task.turns_used + turns;
      const tokensUsed = task.tokens_used + tokensIn + tokensOut;
      this.store.run(
        `INSERT INTO usage_logs(room, task_id, agent_id, turns, tokens_in, tokens_out, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        task.room,
        task.id,
        agentId,
        turns,
        tokensIn,
        tokensOut,
        now,
      );
      const agent = this.requireAgent(agentId);
      const agentTokensToday = this.tokensToday('agent', agentId, now);
      const roomTokensToday = this.tokensToday('room', task.room, now);

      const taskOverTurns = task.budget_turns > 0 && turnsUsed > task.budget_turns;
      const taskOverTokens = task.budget_tokens !== null && tokensUsed > task.budget_tokens;
      const agentOver = agent.daily_budget_tokens !== null && agentTokensToday > agent.daily_budget_tokens;
      const roomOver = room.daily_budget_tokens !== null && roomTokensToday > room.daily_budget_tokens;

      if (taskOverTurns || taskOverTokens || agentOver || roomOver) {
        const scope = taskOverTurns || taskOverTokens ? 'task' : agentOver ? 'agent' : 'room';
        const blocked = this.mutate(
          { owner: room.owner, agent: KEEPER_ACTOR },
          task,
          { status: 'blocked', turns_used: turnsUsed, tokens_used: tokensUsed, lease_until: null },
          'task.blocked',
          {
            reason: 'budget',
            scope,
            turns_used: turnsUsed,
            budget_turns: task.budget_turns,
            budget_tokens: task.budget_tokens,
            tokens_used: tokensUsed,
            agent_tokens_today: agentTokensToday,
            room_tokens_today: roomTokensToday,
          },
        );
        return { ok: false, scope, task: blocked };
      }
      // Usage does not change the board state, so it must not bump `version`
      // (an agent would lose the version it is working with).
      this.store.run(
        'UPDATE tasks SET turns_used = ?, tokens_used = ?, updated_at = ? WHERE id = ?',
        turnsUsed,
        tokensUsed,
        now,
        task.id,
      );
      this.appendEvent({
        room: task.room,
        type: 'usage.reported',
        actor,
        task_id: task.id,
        payload: { turns, tokens_in: tokensIn, tokens_out: tokensOut, turns_used: turnsUsed, tokens_used: tokensUsed },
      });
      return { ok: true, task: this.requireTask(task.id), agent_tokens_today: agentTokensToday };
    });

    if (!outcome.ok) {
      throw errors.budgetExhausted(outcome.scope, { task: outcome.task });
    }
    return { task: outcome.task, agent_tokens_today: outcome.agent_tokens_today };
  }

  tokensToday(scope: 'agent' | 'room', id: string, now: string): number {
    const dayStart = `${now.slice(0, 10)}T00:00:00.000Z`;
    const row =
      scope === 'agent'
        ? this.store.one<{ n: number | null }>(
            `SELECT SUM(tokens_in + tokens_out) AS n FROM usage_logs WHERE agent_id = ? AND ts >= ?`,
            id,
            dayStart,
          )
        : this.store.one<{ n: number | null }>(
            `SELECT SUM(tokens_in + tokens_out) AS n FROM usage_logs WHERE room = ? AND ts >= ?`,
            id,
            dayStart,
          );
    return row?.n ?? 0;
  }

  // --------------------------------------------------------- artifacts

  putArtifact(
    actor: Actor,
    room: string,
    input: {
      task?: string | null;
      name: string;
      content?: string | Buffer;
      mime?: string | null;
      summary?: string | null;
    },
  ): Artifact {
    const r = this.requireRoom(room);
    this.assertMember(r, actor);
    const task = input.task ? this.requireTask(input.task) : null;
    if (task && task.room !== room) throw errors.badRequest('task belongs to another room');
    if (!input.name) throw errors.badRequest('name is required');
    const buffer = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content ?? '', 'utf8');
    if (buffer.byteLength > MAX_ARTIFACT_BYTES) {
      throw errors.badRequest(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    }
    const id = randomId('art', 8);
    const dir = join(this.store.artifactsDir, room);
    mkdirSync(dir, { recursive: true });
    const storagePath = join(dir, id);
    writeFileSync(storagePath, buffer);
    const mime = input.mime ?? guessMime(input.name);
    const preview = buildPreview(buffer, mime);
    const digest = sha256(buffer);
    const now = this.nowIso();
    this.store.run(
      `INSERT INTO artifacts(id, room, task_id, name, mime, bytes, sha256, storage_path, summary,
                             preview, preview_truncated, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      room,
      task?.id ?? null,
      basename(input.name),
      mime,
      buffer.byteLength,
      digest,
      storagePath,
      input.summary ?? null,
      preview.text,
      preview.truncated ? 1 : 0,
      actor.agent ?? actor.owner,
      now,
    );
    this.appendEvent({
      room,
      type: 'artifact.created',
      actor,
      task_id: task?.id ?? null,
      payload: { artifact_id: id, name: input.name, bytes: buffer.byteLength, sha256: digest },
    });
    return mapArtifact(this.store.one<Row>('SELECT * FROM artifacts WHERE id = ?', id)!);
  }

  getArtifact(actor: Actor, id: string): { artifact: Artifact; download_url: string } {
    const row = this.store.one<Row>('SELECT * FROM artifacts WHERE id = ?', id);
    if (!row) throw errors.notFound(`artifact ${id}`);
    const artifact = mapArtifact(row);
    this.assertMember(this.requireRoom(artifact.room), actor);
    return { artifact, download_url: `/v1/artifacts/${id}/blob` };
  }

  readArtifactBlob(actor: Actor, id: string): { artifact: Artifact; buffer: Buffer } {
    const row = this.store.one<Row>('SELECT * FROM artifacts WHERE id = ?', id);
    if (!row) throw errors.notFound(`artifact ${id}`);
    const artifact = mapArtifact(row);
    this.assertMember(this.requireRoom(artifact.room), actor);
    if (actor.agent && actor.agent !== KEEPER_ACTOR) {
      throw errors.forbidden('Only the owner downloads artifact blobs.');
    }
    return { artifact, buffer: readFileSync(row['storage_path'] as string) };
  }

  // ------------------------------------------------------------- board

  board(room: string): {
    room: Room;
    agents: Agent[];
    tasks: Task[];
    approvals: Approval[];
    events: Event[];
    stats: Record<string, number>;
    cursor: number;
  } {
    const r = this.requireRoom(room);
    const tasks = this.listTasks(room);
    const events = this.store
      .all<Row>('SELECT * FROM events WHERE room = ? ORDER BY seq DESC LIMIT 60', room)
      .map(mapEvent)
      .reverse();
    const stats: Record<string, number> = {};
    for (const status of TASK_STATUSES) stats[status] = 0;
    for (const task of tasks) stats[task.status] = (stats[task.status] ?? 0) + 1;
    stats['total'] = tasks.length;
    return {
      room: r,
      agents: this.listAgents(room),
      tasks,
      approvals: this.listApprovals(room, 'pending'),
      events,
      stats,
      cursor: this.log.maxSeq(room),
    };
  }

  /** Deterministic keeper pass; the server also exposes it as an endpoint. */
  keeper(): KeeperReport {
    return keeperTick(this);
  }

  close(): void {
    this.store.close();
  }
}

// --------------------------------------------------------------- helpers

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function agentCanTake(agent: Agent, task: Pick<Task, 'kind' | 'risk'>): boolean {
  if (agent.status !== 'active') return false;
  if (task.kind !== 'general' && task.kind !== 'any' && task.kind !== agent.kind) return false;
  if (RISKY.includes(task.risk)) {
    if (agent.gate === 'hook') return true;
    if (agent.gate === 'vendor' && agent.approval_delegated) return true;
    return false;
  }
  return true;
}

export function validateCheck(check: Check | undefined): Check {
  const kind = check?.kind ?? 'human';
  if (!CHECK_KINDS.includes(kind)) {
    throw errors.badRequest(`check.kind must be one of ${CHECK_KINDS.join(', ')}`);
  }
  if ((kind === 'command' || kind === 'artifact' || kind === 'http') && !check?.target) {
    throw errors.badRequest(`check.target is required for a ${kind} check`);
  }
  return { ...check, kind };
}

function grantKindFor(decision: ApprovalDecision, approval: Approval): GrantKind {
  if (decision.grant_kind) return decision.grant_kind;
  if (approval.normalized_command) return 'normalized';
  return 'action_hash';
}

function guessMime(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    log: 'text/plain',
    ts: 'text/plain',
    js: 'text/plain',
    png: 'image/png',
    jpg: 'image/jpeg',
    pdf: 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}

/**
 * Artifact previews exist for a hosted assistant that cannot reach the local
 * disk. Only text is previewed, control characters are stripped, and the
 * preview never exceeds PREVIEW_CHARS.
 */
export function buildPreview(buffer: Buffer, mime: string): { text: string | null; truncated: boolean } {
  const textLike =
    mime.startsWith('text/') || mime === 'application/json' || mime.endsWith('+json');
  if (!textLike) return { text: null, truncated: false };
  const raw = buffer.toString('utf8');
  const clean = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const truncated = clean.length > PREVIEW_CHARS;
  return { text: truncated ? clean.slice(0, PREVIEW_CHARS) : clean, truncated };
}
