/**
 * The gate call a pre-tool hook makes, and how its answer becomes an exit code.
 *
 *   POST /v1/gate/check {task, action_hash, command, risk, preview}
 *   200 {allow:true}            → exit 0, the tool call proceeds
 *   428 {approval_id}           → exit 2, the agent ends its turn and waits
 *   409 {code:"unread_events"}  → exit 2, the agent reads before it acts
 *   429 budget_exhausted / 403 / 401 / 5xx → exit 2
 *   no answer at all            → exit 2 (fail closed) unless BALLROOM_HOOK_FAIL_OPEN=1
 *
 * Exit 2 is what Claude Code treats as "block this tool call and show stderr to
 * the model", which is why every refusal carries the reason, the approval id and
 * the URL the model (or its owner) needs next.
 */
import { ApiError } from '../errors.js';
import { RoomHttp } from '../client.js';
import type { Risk } from '../types.js';
import type { HookAction } from './protocol.js';

export interface GateContext {
  roomUrl: string;
  token: string;
  task: string;
  /** Only used to print a board link. */
  room?: string | null;
  boardUrl?: string | null;
}

export type GateDecision =
  | { kind: 'allow'; grantId: string; grantKind: string }
  | { kind: 'approval_required'; approvalId: string; risk: Risk | null }
  | { kind: 'unread_events'; sequences: number[]; taskLastSeq: number | null }
  | { kind: 'blocked'; status: number; code: string; message: string }
  | { kind: 'unreachable'; message: string };

interface GateResponseBody {
  status?: number;
  allow?: boolean;
  grant?: { id?: string; kind?: string };
  approval_id?: string;
  code?: string;
  unread_events?: { seq?: number }[];
  task?: { last_seq?: number; risk?: Risk };
}

export async function askGate(
  context: GateContext,
  action: HookAction,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<GateDecision> {
  const http = new RoomHttp(context.roomUrl, {
    token: context.token,
    timeoutMs: options.timeoutMs ?? 5000,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  let response;
  try {
    response = await http.call<GateResponseBody>('POST', '/v1/gate/check', {
      task: context.task,
      action_hash: action.actionHash,
      command: action.command,
      risk: action.risk,
      preview: action.preview,
    });
  } catch (error) {
    return { kind: 'unreachable', message: describeFetchError(error, context.roomUrl) };
  }
  const body = response.body ?? {};
  if (response.status === 200 && body.allow === true) {
    return { kind: 'allow', grantId: body.grant?.id ?? '', grantKind: body.grant?.kind ?? 'unknown' };
  }
  if (response.status === 428) {
    return {
      kind: 'approval_required',
      approvalId: body.approval_id ?? '(none returned)',
      risk: body.task?.risk ?? action.risk,
    };
  }
  if (response.status === 409 && body.code === 'unread_events') {
    const sequences = (body.unread_events ?? [])
      .map((event) => event.seq)
      .filter((seq): seq is number => typeof seq === 'number');
    return { kind: 'unread_events', sequences, taskLastSeq: body.task?.last_seq ?? null };
  }
  // A 409/4xx/5xx thrown as an error envelope (invalid_transition, version
  // conflict, budget, auth) still blocks the call — the reason is the message.
  let message = `the room answered ${response.status}`;
  let code = typeof body.code === 'string' ? body.code : 'request_failed';
  if (response.body && typeof response.body === 'object' && 'error' in (response.body as object)) {
    const error = (response.body as { error?: { code?: string; message?: string } }).error;
    if (typeof error?.message === 'string') message = error.message;
    if (typeof error?.code === 'string') code = error.code;
  }
  return { kind: 'blocked', status: response.status, code, message };
}

function describeFetchError(error: unknown, roomUrl: string): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    const hint = cause?.code ? ` (${cause.code})` : '';
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return `the room at ${roomUrl} did not answer in time`;
    }
    return `${error.message}${hint}`;
  }
  return `the room at ${roomUrl} could not be reached`;
}

export interface RenderOptions {
  context: GateContext;
  action: HookAction;
  /** Allow the call when the room cannot be reached at all. Default: false. */
  failOpen?: boolean;
  agentName?: string | null;
}

export interface RenderResult {
  exitCode: number;
  stderr: string | null;
}

export function boardLink(context: GateContext): string {
  const base = context.roomUrl.replace(/\/+$/, '');
  return context.room ? `${base}/?room=${encodeURIComponent(context.room)}` : base;
}

export function renderDecision(decision: GateDecision, options: RenderOptions): RenderResult {
  const { context, action } = options;
  const head = `${action.tool} · ${action.normalized ?? action.command ?? '(no command)'}`;
  const where = `task ${context.task}${options.agentName ? ` · agent ${options.agentName}` : ''} · risk ${action.risk}`;

  switch (decision.kind) {
    case 'allow':
      return { exitCode: 0, stderr: null };
    case 'approval_required': {
      const lines = [
        `[ballroom] BLOCKED — approval required before this command runs.`,
        `  action:   ${head}`,
        `  because:  ${action.reason}`,
        `  where:    ${where}`,
        `  approval: ${decision.approvalId}`,
        ``,
        `  Ask the owner to run:`,
        `    POST ${context.roomUrl}/v1/approvals/${decision.approvalId}/decision`,
        `    body {"decision":"approve"}   (the owner token is required)`,
        `  Board: ${boardLink(context)}`,
        ``,
        `  Do not retry this command yet: the owner's grant is single-use and is`,
        `  issued only after the approval. End the turn and report that you are`,
        `  waiting on approval ${decision.approvalId}.`,
        ``,
      ];
      return { exitCode: 2, stderr: lines.join('\n') };
    }
    case 'unread_events': {
      const seqs = decision.sequences.length > 0 ? decision.sequences.join(', ') : 'unknown';
      const lines = [
        `[ballroom] BLOCKED — the room has events on this task you have not read (seq ${seqs}).`,
        `  action: ${head}`,
        `  where:  ${where}`,
        `  read them first: GET ${context.roomUrl}/v1/inbox?after=<your cursor>&wait=0`,
        `  then retry the same command. Nothing was approved or executed.`,
        ``,
      ];
      return { exitCode: 2, stderr: lines.join('\n') };
    }
    case 'blocked': {
      const lines = [
        `[ballroom] BLOCKED — ${decision.message}`,
        `  action: ${head}`,
        `  where:  ${where}`,
        `  code:   ${decision.code} (HTTP ${decision.status})`,
        `  board:  ${boardLink(context)}`,
        ``,
      ];
      return { exitCode: 2, stderr: lines.join('\n') };
    }
    case 'unreachable': {
      if (options.failOpen) {
        return {
          exitCode: 0,
          stderr: `[ballroom] WARNING — ${decision.message}. Failing open because BALLROOM_HOOK_FAIL_OPEN=1; this command is NOT gated.\n`,
        };
      }
      const lines = [
        `[ballroom] BLOCKED — the room could not be reached, so this command cannot be approved.`,
        `  action: ${head}`,
        `  where:  ${where}`,
        `  error:  ${decision.message}`,
        ``,
        `  Start ballroomd (npm start) and retry, or set BALLROOM_HOOK_FAIL_OPEN=1 to`,
        `  let a command through when the room is down (that is a deliberate hole).`,
        ``,
      ];
      return { exitCode: 2, stderr: lines.join('\n') };
    }
  }
}

/** Convenience for callers that only have a status/body pair (tests). */
export function decisionFromError(error: unknown): GateDecision | null {
  if (error instanceof ApiError) {
    return { kind: 'blocked', status: error.status, code: error.code, message: error.message };
  }
  return null;
}
