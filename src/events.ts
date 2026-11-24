import type { Store } from './db.js';
import { mapEvent, type Row } from './db.js';
import type { Event } from './types.js';

export interface AppendInput {
  room: string;
  type: string;
  ts: string;
  actor_owner?: string | null;
  actor_agent?: string | null;
  task_id?: string | null;
  payload?: Record<string, unknown>;
  idem_key?: string | null;
}

export interface AppendResult {
  event: Event;
  duplicate: boolean;
}

/**
 * Append-only event log. `seq` is the room-wide order and the cursor every
 * waiting mechanism uses (poll, long-poll, websocket, webhook).
 *
 * Idempotency: `UNIQUE(room, actor_agent, idem_key)` means a retry of the same
 * write returns the event that already landed instead of a second one.
 */
export class EventLog {
  constructor(private readonly store: Store) {}

  append(input: AppendInput): AppendResult {
    const idem = input.idem_key ?? null;
    if (idem) {
      const existing = this.store.one<Row>(
        `SELECT * FROM events WHERE room = ? AND actor_agent IS ? AND idem_key = ?`,
        input.room,
        input.actor_agent ?? null,
        idem,
      );
      if (existing) return { event: mapEvent(existing), duplicate: true };
    }
    const info = this.store.run(
      `INSERT INTO events(room, type, actor_owner, actor_agent, task_id, payload_json, ts, idem_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.room,
      input.type,
      input.actor_owner ?? null,
      input.actor_agent ?? null,
      input.task_id ?? null,
      JSON.stringify(input.payload ?? {}),
      input.ts,
      idem,
    );
    const seq = Number(info.lastInsertRowid);
    const row = this.store.one<Row>('SELECT * FROM events WHERE seq = ?', seq);
    return { event: mapEvent(row!), duplicate: false };
  }

  maxSeq(room: string): number {
    const row = this.store.one<{ seq: number | null }>(
      'SELECT MAX(seq) AS seq FROM events WHERE room = ?',
      room,
    );
    return row?.seq ?? 0;
  }

  get(seq: number): Event | undefined {
    const row = this.store.one<Row>('SELECT * FROM events WHERE seq = ?', seq);
    return row ? mapEvent(row) : undefined;
  }

  range(room: string, after: number, limit = 200): Event[] {
    return this.store
      .all<Row>(
        'SELECT * FROM events WHERE room = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
        room,
        after,
        limit,
      )
      .map(mapEvent);
  }

  forTask(taskId: string, after: number, limit = 50): Event[] {
    return this.store
      .all<Row>(
        'SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
        taskId,
        after,
        limit,
      )
      .map(mapEvent);
  }

  /** Events on a task after `afterSeq` written by someone other than `agent`. */
  forTaskFromOthers(taskId: string, after: number, agent: string, limit = 50): Event[] {
    return this.store
      .all<Row>(
        `SELECT * FROM events WHERE task_id = ? AND seq > ? AND IFNULL(actor_agent, '') <> ?
         ORDER BY seq ASC LIMIT ?`,
        taskId,
        after,
        agent,
        limit,
      )
      .map(mapEvent);
  }

  countMessagesSince(room: string, sinceIso: string, agent?: string): number {
    const row = agent
      ? this.store.one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM events
           WHERE room = ? AND type = 'message.posted' AND actor_agent = ? AND ts >= ?`,
          room,
          agent,
          sinceIso,
        )
      : this.store.one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM events
           WHERE room = ? AND type = 'message.posted' AND ts >= ?`,
          room,
          sinceIso,
        );
    return row?.n ?? 0;
  }

  countSignatureSince(room: string, signature: string, sinceIso: string): number {
    const row = this.store.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events
       WHERE room = ? AND type = 'message.posted' AND ts >= ?
         AND json_extract(payload_json, '$.signature') = ?`,
      room,
      sinceIso,
      signature,
    );
    return row?.n ?? 0;
  }

  /**
   * Snapshot compaction: drop events below `upToSeq`, remember the watermark.
   * A cursor below the watermark receives `409 snapshot_required` instead of a
   * silent gap (docs/SPEC.md §4.1).
   */
  compact(room: string, upToSeq: number): { deleted: number; truncatedBefore: number } {
    const info = this.store.run('DELETE FROM events WHERE room = ? AND seq <= ?', room, upToSeq);
    const previous = this.truncatedBefore(room);
    const watermark = Math.max(previous, upToSeq);
    this.store.setMeta(`truncated_before:${room}`, String(watermark));
    return { deleted: info.changes, truncatedBefore: watermark };
  }

  truncatedBefore(room: string): number {
    return Number(this.store.getMeta(`truncated_before:${room}`) ?? 0);
  }
}
