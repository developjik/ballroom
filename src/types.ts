/**
 * ballroom — core domain types.
 *
 * The board (tasks) is the source of truth. Every mutation is appended to the
 * event log, which carries the room-wide ordering (`seq`). Chat is a projection
 * of the log, not a separate store.
 */

export type TaskStatus =
  | 'open'
  | 'assigned'
  | 'running'
  | 'waiting'
  | 'awaiting_approval'
  | 'blocked'
  | 'review'
  | 'done'
  | 'failed';

export type Risk = 'read' | 'write_local' | 'irreversible' | 'spend' | 'outbound';

export type AgentKind = 'cli' | 'hosted' | 'human';

export type AgentStatus = 'pending' | 'active' | 'disabled';

export type Participate = 'mcp' | 'http';

export type Wake = 'push' | 'poll';

export type Gate = 'hook' | 'vendor' | 'none';

export type VerifyResult = 'none' | 'passed' | 'rejected' | 'human_confirmed';

export type CheckKind = 'command' | 'artifact' | 'http' | 'human' | 'peer';

export interface Check {
  kind: CheckKind;
  /** Shell command for `command`, path for `artifact`, URL for `http`. */
  target?: string;
  /** Expected exit code / sha256 / status. */
  expect?: string;
}

export interface Room {
  room: string;
  owner: string;
  unattended: boolean;
  autodispatch: boolean;
  approval_ttl_minutes: number;
  daily_budget_tokens: number | null;
  created_at: string;
}

export interface Agent {
  id: string;
  owner: string;
  room: string;
  kind: AgentKind;
  participate: Participate;
  wake: Wake;
  gate: Gate;
  approval_delegated: boolean;
  status: AgentStatus;
  lease_default_min: number;
  stale_after_min: number;
  daily_budget_tokens: number | null;
  last_seen_at: string | null;
  last_delivered_seq: number;
  created_at: string;
}

export interface Task {
  id: string;
  room: string;
  title: string;
  body_md: string;
  kind: string;
  priority: number;
  risk: Risk;
  status: TaskStatus;
  version: number;
  last_seq: number;
  /** Assignment: persists across lease expiry. */
  assignee: string | null;
  assigned_at: string | null;
  /** Lease: exists only while `running`. */
  lease_until: string | null;
  attempt: number;
  scope_lock: string | null;
  wait_reason: string | null;
  wait_until: string | null;
  wait_since_seq: number | null;
  parent_id: string | null;
  depends_on: string[];
  budget_turns: number;
  budget_tokens: number | null;
  turns_used: number;
  tokens_used: number;
  resume_note_md: string | null;
  check: Check;
  proof: unknown | null;
  verify: VerifyResult;
  verified_by: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Event {
  seq: number;
  room: string;
  type: string;
  actor_owner: string | null;
  actor_agent: string | null;
  task_id: string | null;
  payload: Record<string, unknown>;
  ts: string;
  idem_key: string | null;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface Approval {
  id: string;
  room: string;
  task_id: string;
  agent_id: string;
  status: ApprovalStatus;
  risk: Risk;
  action_hash: string;
  normalized_command: string | null;
  preview: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  note: string | null;
}

export type GrantKind = 'action_hash' | 'normalized' | 'pattern' | 'runner_exec';

export interface Grant {
  id: string;
  room: string;
  task_id: string;
  agent_id: string;
  approval_id: string | null;
  kind: GrantKind;
  action_hash: string | null;
  normalized_command: string | null;
  pattern: string | null;
  uses_left: number;
  expires_at: string;
  created_at: string;
  used_at: string | null;
}

export interface Artifact {
  id: string;
  room: string;
  task_id: string | null;
  name: string;
  mime: string | null;
  bytes: number;
  sha256: string;
  summary: string | null;
  preview: string | null;
  preview_truncated: boolean;
  created_by: string | null;
  created_at: string;
}

export interface UsageReport {
  task: string;
  turns: number;
  tokens_in: number;
  tokens_out: number;
}

export interface SignupInput {
  name: string;
  kind: AgentKind;
  room: string;
  participate?: Participate;
  wake?: Wake;
  gate?: Gate;
  approval_delegated?: boolean;
  lease_default_min?: number;
  stale_after_min?: number;
  daily_budget_tokens?: number | null;
}

export interface CreateTaskInput {
  title: string;
  body_md?: string;
  kind?: string;
  priority?: number;
  risk?: Risk;
  check?: Check;
  assignee?: string | null;
  scope_lock?: string | null;
  budget_turns?: number;
  budget_tokens?: number | null;
  parent_id?: string | null;
  depends_on?: string[];
  idem_key?: string | null;
}

export interface GateCheckInput {
  task: string;
  action_hash: string;
  risk?: Risk;
  preview?: string;
  command?: string;
  /** Who would execute the approved action. `runner` means the runner executes
   *  the command directly instead of resuming the model session. */
  executor?: 'agent' | 'runner';
}

export type GateCheckResult =
  | { status: 200; allow: true; grant: { id: string; kind: GrantKind }; task: Task }
  | { status: 428; allow: false; approval_id: string; task: Task }
  | { status: 409; allow: false; code: string; unread_events?: Event[]; task: Task };

export interface ApprovalDecision {
  decision: 'approve' | 'deny';
  note?: string;
  /** How the single-use grant will match the follow-up call. Defaults to
   *  `normalized` (normalized command), falling back to `action_hash`. */
  grant_kind?: GrantKind;
  /** Required for `pattern` grants. */
  pattern?: string;
  /** Seconds the grant stays usable. Default 1800, max till approval expiry. */
  ttl_seconds?: number;
}
