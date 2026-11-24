import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type {
  Agent,
  Approval,
  Artifact,
  Event,
  Grant,
  Room,
  Task,
} from './types.js';
import { parseJson } from './util.js';

export type Row = Record<string, any>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  room                 TEXT PRIMARY KEY,
  owner                TEXT NOT NULL,
  unattended           INTEGER NOT NULL DEFAULT 0,
  autodispatch         INTEGER NOT NULL DEFAULT 1,
  approval_ttl_minutes INTEGER NOT NULL DEFAULT 1440,
  daily_budget_tokens  INTEGER,
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id                  TEXT PRIMARY KEY,
  owner               TEXT NOT NULL,
  room                TEXT NOT NULL,
  kind                TEXT NOT NULL,
  participate         TEXT NOT NULL DEFAULT 'http',
  wake                TEXT NOT NULL DEFAULT 'poll',
  gate                TEXT NOT NULL DEFAULT 'none',
  approval_delegated  INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'pending',
  key_hash            TEXT NOT NULL,
  confirm_token_hash  TEXT,
  lease_default_min   INTEGER NOT NULL DEFAULT 5,
  stale_after_min     INTEGER NOT NULL DEFAULT 60,
  daily_budget_tokens INTEGER,
  last_seen_at        TEXT,
  last_delivered_seq  INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agents_room ON agents(room, status);
CREATE UNIQUE INDEX IF NOT EXISTS agents_key ON agents(key_hash);

CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  room             TEXT NOT NULL,
  title            TEXT NOT NULL,
  body_md          TEXT NOT NULL DEFAULT '',
  kind             TEXT NOT NULL DEFAULT 'general',
  priority         INTEGER NOT NULL DEFAULT 0,
  risk             TEXT NOT NULL DEFAULT 'write_local',
  status           TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  last_seq         INTEGER NOT NULL DEFAULT 0,
  assignee         TEXT,
  assigned_at      TEXT,
  lease_until      TEXT,
  attempt          INTEGER NOT NULL DEFAULT 0,
  scope_lock       TEXT,
  wait_reason      TEXT,
  wait_until       TEXT,
  wait_since_seq   INTEGER,
  parent_id        TEXT,
  depends_on_json  TEXT NOT NULL DEFAULT '[]',
  budget_turns     INTEGER NOT NULL DEFAULT 12,
  budget_tokens    INTEGER,
  turns_used       INTEGER NOT NULL DEFAULT 0,
  tokens_used      INTEGER NOT NULL DEFAULT 0,
  resume_note_md   TEXT,
  check_json       TEXT NOT NULL DEFAULT '{"kind":"human"}',
  proof_json       TEXT,
  verify           TEXT NOT NULL DEFAULT 'none',
  verified_by      TEXT,
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_room_status ON tasks(room, status);
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(assignee);

CREATE TABLE IF NOT EXISTS events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  room         TEXT NOT NULL,
  type         TEXT NOT NULL,
  actor_owner  TEXT,
  actor_agent  TEXT,
  task_id      TEXT,
  payload_json TEXT NOT NULL,
  ts           TEXT NOT NULL,
  idem_key     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS events_idem
  ON events(room, actor_agent, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_room_seq ON events(room, seq);
CREATE INDEX IF NOT EXISTS events_task_seq ON events(task_id, seq);
CREATE INDEX IF NOT EXISTS events_rate ON events(room, actor_agent, ts);

CREATE TABLE IF NOT EXISTS approvals (
  id                 TEXT PRIMARY KEY,
  room               TEXT NOT NULL,
  task_id            TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  status             TEXT NOT NULL,
  risk               TEXT NOT NULL,
  action_hash        TEXT NOT NULL,
  normalized_command TEXT,
  preview            TEXT,
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  decided_at         TEXT,
  decided_by         TEXT,
  note               TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS approvals_pending
  ON approvals(task_id, agent_id, action_hash) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS approvals_room ON approvals(room, status);

CREATE TABLE IF NOT EXISTS grants (
  id                 TEXT PRIMARY KEY,
  room               TEXT NOT NULL,
  task_id            TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  approval_id        TEXT,
  kind               TEXT NOT NULL,
  action_hash        TEXT,
  normalized_command TEXT,
  pattern            TEXT,
  uses_left          INTEGER NOT NULL DEFAULT 1,
  expires_at         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  used_at            TEXT
);
CREATE INDEX IF NOT EXISTS grants_lookup ON grants(task_id, agent_id, uses_left);

CREATE TABLE IF NOT EXISTS artifacts (
  id                 TEXT PRIMARY KEY,
  room               TEXT NOT NULL,
  task_id            TEXT,
  name               TEXT NOT NULL,
  mime               TEXT,
  bytes              INTEGER NOT NULL,
  sha256             TEXT NOT NULL,
  storage_path       TEXT NOT NULL,
  summary            TEXT,
  preview            TEXT,
  preview_truncated  INTEGER NOT NULL DEFAULT 0,
  created_by         TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_room ON artifacts(room, task_id);

CREATE TABLE IF NOT EXISTS usage_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room       TEXT NOT NULL,
  task_id    TEXT,
  agent_id   TEXT,
  turns      INTEGER NOT NULL DEFAULT 0,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  ts         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_room_ts ON usage_logs(room, ts);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

export interface StoreOptions {
  /** SQLite file, or ':memory:'. */
  file?: string;
  /** Where artifact blobs live. Defaults to `<dirname(file)>/artifacts`. */
  artifactsDir?: string;
}

export class Store {
  readonly db: Database.Database;
  readonly artifactsDir: string;

  constructor(options: StoreOptions = {}) {
    const file = options.file ?? ':memory:';
    if (file !== ':memory:') {
      const dir = join(file, '..');
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(file);
    // One writer per room is the deployment model; a busy timeout keeps
    // concurrent readers/claimers honest instead of failing with SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    if (file !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.artifactsDir =
      options.artifactsDir ??
      (file === ':memory:' ? join(process.cwd(), '.ballroom-artifacts') : join(file, '..', 'artifacts'));
    mkdirSync(this.artifactsDir, { recursive: true });
  }

  /** Run `fn` inside an IMMEDIATE transaction (the room's single writer). */
  immediate<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx.immediate();
  }

  one<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: unknown[]) {
    return this.db.prepare(sql).run(...params);
  }

  getMeta(key: string): string | null {
    const row = this.one<{ v: string }>('SELECT v FROM meta WHERE k = ?', key);
    return row ? row.v : null;
  }

  setMeta(key: string, value: string): void {
    this.run(
      'INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      key,
      value,
    );
  }

  close(): void {
    this.db.close();
  }
}

const bool = (value: unknown): boolean => value === 1 || value === true || value === '1';

export function mapRoom(row: Row): Room {
  return {
    room: row.room,
    owner: row.owner,
    unattended: bool(row.unattended),
    autodispatch: bool(row.autodispatch),
    approval_ttl_minutes: row.approval_ttl_minutes,
    daily_budget_tokens: row.daily_budget_tokens ?? null,
    created_at: row.created_at,
  };
}

export function mapAgent(row: Row): Agent {
  return {
    id: row.id,
    owner: row.owner,
    room: row.room,
    kind: row.kind,
    participate: row.participate,
    wake: row.wake,
    gate: row.gate,
    approval_delegated: bool(row.approval_delegated),
    status: row.status,
    lease_default_min: row.lease_default_min,
    stale_after_min: row.stale_after_min,
    daily_budget_tokens: row.daily_budget_tokens ?? null,
    last_seen_at: row.last_seen_at ?? null,
    last_delivered_seq: row.last_delivered_seq,
    created_at: row.created_at,
  };
}

export function mapTask(row: Row): Task {
  return {
    id: row.id,
    room: row.room,
    title: row.title,
    body_md: row.body_md,
    kind: row.kind,
    priority: row.priority,
    risk: row.risk,
    status: row.status,
    version: row.version,
    last_seq: row.last_seq,
    assignee: row.assignee ?? null,
    assigned_at: row.assigned_at ?? null,
    lease_until: row.lease_until ?? null,
    attempt: row.attempt,
    scope_lock: row.scope_lock ?? null,
    wait_reason: row.wait_reason ?? null,
    wait_until: row.wait_until ?? null,
    wait_since_seq: row.wait_since_seq ?? null,
    parent_id: row.parent_id ?? null,
    depends_on: parseJson<string[]>(row.depends_on_json, []),
    budget_turns: row.budget_turns,
    budget_tokens: row.budget_tokens ?? null,
    turns_used: row.turns_used,
    tokens_used: row.tokens_used,
    resume_note_md: row.resume_note_md ?? null,
    check: parseJson(row.check_json, { kind: 'human' as const }),
    proof: parseJson<unknown>(row.proof_json, null),
    verify: row.verify,
    verified_by: row.verified_by ?? null,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function mapEvent(row: Row): Event {
  return {
    seq: row.seq,
    room: row.room,
    type: row.type,
    actor_owner: row.actor_owner ?? null,
    actor_agent: row.actor_agent ?? null,
    task_id: row.task_id ?? null,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    ts: row.ts,
    idem_key: row.idem_key ?? null,
  };
}

export function mapApproval(row: Row): Approval {
  return {
    id: row.id,
    room: row.room,
    task_id: row.task_id,
    agent_id: row.agent_id,
    status: row.status,
    risk: row.risk,
    action_hash: row.action_hash,
    normalized_command: row.normalized_command ?? null,
    preview: row.preview ?? null,
    created_at: row.created_at,
    expires_at: row.expires_at,
    decided_at: row.decided_at ?? null,
    decided_by: row.decided_by ?? null,
    note: row.note ?? null,
  };
}

export function mapGrant(row: Row): Grant {
  return {
    id: row.id,
    room: row.room,
    task_id: row.task_id,
    agent_id: row.agent_id,
    approval_id: row.approval_id ?? null,
    kind: row.kind,
    action_hash: row.action_hash ?? null,
    normalized_command: row.normalized_command ?? null,
    pattern: row.pattern ?? null,
    uses_left: row.uses_left,
    expires_at: row.expires_at,
    created_at: row.created_at,
    used_at: row.used_at ?? null,
  };
}

export function mapArtifact(row: Row): Artifact {
  return {
    id: row.id,
    room: row.room,
    task_id: row.task_id ?? null,
    name: row.name,
    mime: row.mime ?? null,
    bytes: row.bytes,
    sha256: row.sha256,
    summary: row.summary ?? null,
    preview: row.preview ?? null,
    preview_truncated: bool(row.preview_truncated),
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}
