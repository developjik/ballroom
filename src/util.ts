import { createHash, randomBytes } from 'node:crypto';

/** Timestamps are ISO-8601 in UTC with millisecond precision. */
export type Iso = string;

export function nowIso(clock: { now(): Date } = { now: () => new Date() }): Iso {
  return clock.now().toISOString();
}

export function addMs(iso: Iso, ms: number): Iso {
  return new Date(Date.parse(iso) + ms).toISOString();
}

export function addMinutes(iso: Iso, minutes: number): Iso {
  return addMs(iso, minutes * 60_000);
}

export function isPast(iso: Iso, now: Iso): boolean {
  return Date.parse(iso) <= Date.parse(now);
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function randomId(prefix: string, bytes = 6): string {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`;
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function json<T>(value: T): string {
  return JSON.stringify(value);
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Scope locks answer "which resources does this task own while it runs?".
 *
 * A lock is a `;`-separated list of resource keys, e.g.
 *   `repo:developjik/ballroom#branch:main;path:src/board.ts`
 *
 * Normalisation: trim, case-fold, collapse internal whitespace, drop a trailing
 * `/` from path segments. Two tasks conflict when any resource of one equals or
 * is a path-prefix of a resource of the other, so `path:src` conflicts with
 * `path:src/api` but not with `path:src2`.
 */
export function normalizeScopeLock(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parts = raw
    .split(';')
    .map((part) => normalizeResource(part))
    .filter((part): part is string => part !== null)
    .sort();
  return parts.length > 0 ? parts.join(';') : null;
}

function normalizeResource(raw: string): string | null {
  let value = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (value === '') return null;
  // Normalise Windows separators and duplicated slashes for path resources.
  value = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const [scheme, ...rest] = value.split(':');
  if (rest.length === 0) return value.replace(/\/+$/, '');
  let body = rest.join(':').replace(/\/+$/, '');
  if (scheme === 'path') {
    // Paths are absolute-ish keys; a leading `./` is noise.
    body = body.replace(/^\.\//, '');
    if (!body.startsWith('/')) body = `/${body}`;
  }
  return `${scheme}:${body}`;
}

function isPrefixOf(prefix: string, value: string): boolean {
  if (prefix === value) return true;
  const boundary = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return value.startsWith(boundary);
}

export function scopeLocksConflict(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const left = a.split(';');
  const right = b.split(';');
  for (const one of left) {
    for (const other of right) {
      if (isPrefixOf(one, other) || isPrefixOf(other, one)) return true;
    }
  }
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
