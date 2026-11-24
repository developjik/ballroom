/**
 * Errors map 1:1 onto the wire contract in docs/SPEC.md §3.4.
 * Anything thrown as an ApiError is serialised by the HTTP layer; everything
 * else is a bug and becomes a 500 without leaking internals.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return { error: { code: this.code, message: this.message, ...this.details } };
  }
}

export const errors = {
  unauthenticated: (message = 'Missing or unknown API key.') =>
    new ApiError(401, 'unauthenticated', message),
  forbidden: (message = 'This key may not perform this action.') =>
    new ApiError(403, 'forbidden', message),
  notFound: (what: string) => new ApiError(404, 'not_found', `${what} not found.`),
  badRequest: (message: string, details: Record<string, unknown> = {}) =>
    new ApiError(400, 'bad_request', message, details),
  versionConflict: (latest: unknown) =>
    new ApiError(409, 'version_conflict', 'The version you read is not the latest one.', { latest }),
  alreadyClaimed: (assignee: string | null, task: unknown) =>
    new ApiError(409, 'already_claimed', 'Another agent is the assignee of this task.', {
      assignee,
      task,
    }),
  unreadEvents: (events: unknown[]) =>
    new ApiError(409, 'unread_events', 'There are events you have not read.', { events }),
  scopeLocked: (conflict: unknown) =>
    new ApiError(409, 'scope_locked', 'Another running task holds the same scope lock.', {
      conflict,
    }),
  snapshotRequired: (snapshot: unknown) =>
    new ApiError(409, 'snapshot_required', 'The cursor is outside the retained event range.', {
      snapshot,
    }),
  approvalRequired: (approvalId: string, approval: unknown) =>
    new ApiError(428, 'approval_required', 'This action needs the owner’s approval.', {
      approval_id: approvalId,
      approval,
    }),
  rateLimited: (bucket: string, retryAfterSeconds: number) =>
    new ApiError(429, 'rate_limited', `Rate limit exceeded for ${bucket}.`, {
      bucket,
      retry_after: retryAfterSeconds,
    }),
  budgetExhausted: (scope: string, detail: Record<string, unknown> = {}) =>
    new ApiError(429, 'budget_exhausted', `Budget exhausted for ${scope}.`, { scope, ...detail }),
  loopDetected: (signature: string, count: number) =>
    new ApiError(429, 'loop_detected', 'The same message repeated too many times.', {
      signature,
      count,
    }),
  conflictState: (status: string, allowed: string[]) =>
    new ApiError(409, 'invalid_transition', `The task is ${status}; this action needs ${allowed.join(', ')}.`, {
      status,
      allowed,
    }),
};
