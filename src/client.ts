/**
 * The smallest room client: one JSON call over fetch.
 *
 * Both the hook (a short-lived process) and the worker (a long-running one)
 * need the same three things — a base URL, a bearer key and a timeout — so
 * they share this file instead of each growing its own fetch wrapper.
 *
 * Errors keep the wire contract of docs/SPEC.md §3.4: a non-2xx answer becomes
 * an ApiError with the room's `code` and `details`, so callers can branch on
 * `409 unread_events` without re-parsing the body.
 */
import { ApiError } from './errors.js';

export interface RoomHttpOptions {
  token?: string;
  /** Per-call default timeout in milliseconds. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RoomResponse<T> {
  status: number;
  body: T;
}

export function normalizeRoomUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') throw new Error('a room URL is required (http://host:port)');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

export class RoomHttp {
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, options: RoomHttpOptions = {}) {
    this.baseUrl = normalizeRoomUrl(baseUrl);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<RoomResponse<T>> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text.trim() !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed as T };
  }

  /** Like `call`, but a non-2xx answer throws the room's ApiError. */
  async expect<T>(method: 'GET' | 'POST', path: string, body?: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    const response = await this.call<T>(method, path, body, options);
    if (response.status < 200 || response.status >= 300) {
      throw toApiError(response.status, response.body);
    }
    return response.body;
  }
}

export function toApiError(status: number, body: unknown): ApiError {
  const envelope = (body ?? {}) as { error?: { code?: string; message?: string; [key: string]: unknown } } & Record<
    string,
    unknown
  >;
  const error = envelope.error;
  const code = typeof error?.code === 'string' ? error.code : status === 401 ? 'unauthenticated' : 'request_failed';
  const message = typeof error?.message === 'string' ? error.message : `the room answered ${status}`;
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(envelope)) {
    if (key !== 'error') details[key] = value;
  }
  for (const [key, value] of Object.entries(error ?? {})) {
    if (key !== 'error' && key !== 'code' && key !== 'message') details[key] = value;
  }
  return new ApiError(status, code, message, details);
}
