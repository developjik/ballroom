/**
 * Typed calls the worker makes against the room. Thin on purpose: every method
 * is one endpoint of docs/SPEC.md §14, and a non-2xx answer throws the room's
 * ApiError so the worker can branch on `code` instead of parsing prose.
 */
import { RoomHttp } from '../client.js';
import type { Artifact, Event, Room, Task } from '../types.js';

export interface InboxPage {
  cursor: number;
  items: Event[];
}

export interface CreateTaskBody {
  title: string;
  body_md?: string;
  kind?: string;
  risk?: string;
  check?: { kind: string; target?: string };
  assignee?: string | null;
  scope_lock?: string | null;
  budget_turns?: number;
  budget_tokens?: number | null;
  idem_key?: string | null;
}

export interface ArtifactInput {
  name: string;
  content: string | Buffer;
  mime?: string;
  summary?: string;
}

export class RoomApi {
  readonly http: RoomHttp;

  constructor(baseUrl: string, token?: string, options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}) {
    this.http = new RoomHttp(baseUrl, {
      ...(token ? { token } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  /** Long-poll: the request returns as soon as the room has anything for me. */
  async inbox(after: number, waitSeconds = 0): Promise<InboxPage> {
    const path = `/v1/inbox?after=${after}&wait=${Math.max(0, Math.trunc(waitSeconds))}`;
    // The HTTP layer caps `wait` at its own maximum; give the socket the same
    // room plus a margin so a 30s wait is not cut off at 10s.
    return this.http.expect<InboxPage>('GET', path, undefined, {
      timeoutMs: (Math.max(0, Math.trunc(waitSeconds)) + 15) * 1000,
    });
  }

  async task(id: string): Promise<Task> {
    const body = await this.http.expect<{ task: Task }>('GET', `/v1/tasks/${encodeURIComponent(id)}`);
    return body.task;
  }

  async tasks(room: string): Promise<Task[]> {
    const body = await this.http.expect<{ tasks: Task[] }>('GET', `/v1/rooms/${encodeURIComponent(room)}/board`);
    return body.tasks;
  }

  async room(name: string): Promise<Room> {
    const body = await this.http.expect<{ room: Room }>('GET', `/v1/rooms/${encodeURIComponent(name)}`);
    return body.room;
  }

  async createTask(room: string, body: CreateTaskBody): Promise<Task> {
    const answer = await this.http.expect<{ task: Task }>('POST', `/v1/rooms/${encodeURIComponent(room)}/tasks`, body);
    return answer.task;
  }

  async claim(taskId: string, version: number, leaseMinutes?: number): Promise<Task> {
    const body = await this.http.expect<{ task: Task }>('POST', `/v1/tasks/${encodeURIComponent(taskId)}/claim`, {
      version,
      ...(leaseMinutes ? { lease_minutes: leaseMinutes } : {}),
    });
    return body.task;
  }

  async renew(taskId: string, leaseMinutes?: number): Promise<Task> {
    const body = await this.http.expect<{ task: Task }>('POST', `/v1/tasks/${encodeURIComponent(taskId)}/renew`, {
      ...(leaseMinutes ? { lease_minutes: leaseMinutes } : {}),
    });
    return body.task;
  }

  async complete(taskId: string, input: { version: number; read_seq: number; proof: unknown }): Promise<Task> {
    const body = await this.http.expect<{ task: Task }>('POST', `/v1/tasks/${encodeURIComponent(taskId)}/complete`, input);
    return body.task;
  }

  async block(taskId: string, input: { version?: number; reason: string }): Promise<Task> {
    const body = await this.http.expect<{ task: Task }>('POST', `/v1/tasks/${encodeURIComponent(taskId)}/block`, input);
    return body.task;
  }

  async release(taskId: string, version: number): Promise<Task> {
    const body = await this.http.expect<{ task: Task }>('POST', `/v1/tasks/${encodeURIComponent(taskId)}/release`, {
      version,
    });
    return body.task;
  }

  async reportUsage(report: { task: string; turns: number; tokens_in: number; tokens_out: number }): Promise<{
    task: Task;
    agent_tokens_today: number;
  }> {
    return this.http.expect('POST', '/v1/usage', report);
  }

  async putArtifact(taskId: string, artifact: ArtifactInput): Promise<{ artifact: Artifact; download_url: string }> {
    const content = Buffer.isBuffer(artifact.content) ? artifact.content : Buffer.from(artifact.content, 'utf8');
    return this.http.expect('POST', `/v1/tasks/${encodeURIComponent(taskId)}/artifacts`, {
      name: artifact.name,
      content_base64: content.toString('base64'),
      ...(artifact.mime ? { mime: artifact.mime } : {}),
      ...(artifact.summary ? { summary: artifact.summary } : {}),
    });
  }

  async verify(taskId: string, input: { result: string; evidence?: unknown }): Promise<Task> {
    const body = await this.http.expect<{ task: Task }>('POST', `/v1/tasks/${encodeURIComponent(taskId)}/verify`, input);
    return body.task;
  }

  async decideApproval(approvalId: string, decision: 'approve' | 'deny', note?: string): Promise<unknown> {
    return this.http.expect('POST', `/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
      decision,
      ...(note ? { note } : {}),
    });
  }
}
