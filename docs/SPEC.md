# ballroom specification

Status: **Phase 1 implemented** (2026-11-24). This document is the contract the code
implements; where the implementation is narrower than the design, the difference is written
down in §17 instead of being left implicit.

Background and prior art (MCP 2026-07-28, A2A 1.0, Agent Board arXiv 2611.04100, "Worse
Together") are summarised in [PHASE0.md](PHASE0.md) §0 and in the v2 design note this
repository implements.

---

## 1. Scope

ballroom is a room where several agents and one owner work on a shared board.

- The **board** (tasks) is the truth. Chat is a projection of the event log.
- Every mutation is an **event** with a room-wide sequence number `seq`.
- A **deterministic keeper** leases, wakes, expires and dispatches. It never calls a model.
- Risky actions pass a **gate** before they execute; the owner decision produces a
  **single-use grant**.
- Verification produces `done`; a claim of completion alone does not.

Out of scope for Phase 1: MCP server and OAuth (Phase 3), the CLI-side hook script and runner
wiring (Phase 2), multi-user rooms, key-pair signing, graph index, prose wake conditions.

## 2. Terms

| Term | Meaning |
|---|---|
| room | one board, one owner, one SQLite writer |
| agent | an identity with a key and three capability records (`participate`, `wake`, `gate`) |
| task | a unit of work with a state, a version and (while running) a lease |
| assignment | `assignee` — who owns the task; persists across lease expiry |
| lease | `lease_until` — a deadline that exists only while `running` |
| event | an immutable record with `seq`; the log is the audit trail |
| cursor | the last `seq` a client has seen |
| grant | a single-use permission produced by an owner decision |
| keeper | the deterministic scheduler (`src/keeper.ts`) |

## 3. Connection surface

### 3.1 Authentication

```
Authorization: Bearer <token>
```

Two kinds of token:

| Token | Who | Power |
|---|---|---|
| owner token | the human who runs the server | create rooms, approve/deny, resolve blocked tasks, download artifacts, tick the keeper, read any board |
| agent key | one agent | act as that agent inside its own room only |

Agent keys are stored as `sha256(key)`; the plaintext is returned exactly once at signup. An
agent key that is not yet confirmed by the owner is refused with `401 unauthenticated` — the
row exists, the key can do nothing.

### 3.2 Signup and confirmation

```
POST /v1/signup   {name, kind, room, participate?, wake?, gate?, approval_delegated?,
                   lease_default_min?, stale_after_min?, daily_budget_tokens?}
  → 201 {agent, key, confirm_token}

POST /v1/agents/:id/confirm  {confirm_token}
  → 200 {agent}          # status becomes active
```

`name` is the agent id and the handle used by mentions: `[a-z0-9][a-z0-9._-]{1,63}`, unique
across the server.

Defaults by kind:

| kind | participate | wake | gate | lease_default_min |
|---|---|---|---|---|
| `cli` | `http` | `push` | `hook` | 5 |
| `hosted` | `mcp` | `poll` | `vendor` | 60 |
| `human` | `http` | `poll` | `none` | 60 |

### 3.3 Waiting

All three waiting mechanisms use the same cursor.

1. **poll** — `GET /v1/inbox?after=<seq>`
2. **long-poll** — same request with `wait=<seconds>` (max 60); an empty answer is exactly
   `{cursor, items: []}`
3. **push** — WebSocket/webhook for runners and endpoints (not in Phase 1; the event log
   already carries everything a push needs)

`GET /v1/inbox` also advances the agent's *delivered* watermark, which the confirm guard in
§8 uses. Items exclude the agent's own events.

### 3.4 Error codes

| HTTP | code | Meaning |
|---|---|---|
| 400 | `bad_request` | missing or invalid field |
| 401 | `unauthenticated` | no key, unknown key, or unconfirmed key |
| 403 | `forbidden` | not this room, not the assignee, not the owner |
| 404 | `not_found` | unknown room/task/agent/artifact |
| 409 | `version_conflict` | the `version` you sent is not current; the response carries `latest` |
| 409 | `already_claimed` | another agent is the assignee; the response carries `assignee` |
| 409 | `unread_events` | there are events you have not read; the response carries `events` |
| 409 | `invalid_transition` | this action does not apply in this state; the response carries `status`, `allowed` |
| 409 | `scope_locked` | another running task holds an overlapping scope lock; carries `conflict` |
| 409 | `snapshot_required` | the cursor is older than the retained log; carries a board `snapshot` |
| 428 | `approval_required` | the owner must decide; carries `approval_id` |
| 429 | `rate_limited` | per-agent or per-room message rate; carries `bucket`, `retry_after` |
| 429 | `budget_exhausted` | task/agent/room budget; carries `scope` and the blocked `task` |
| 429 | `loop_detected` | the same signature repeated; carries `signature`, `count` |
| 413 | `payload_too_large` | body over the limit (256 KB JSON, 8 MB artifact) |

## 4. Data model

### 4.1 Events

```
event(seq INTEGER PK AUTOINCREMENT, room, type, actor_owner, actor_agent, task_id,
      payload_json, ts, idem_key)
  UNIQUE(room, actor_agent, idem_key) WHERE idem_key IS NOT NULL
```

- `seq` is global and monotonic; it is the only ordering anyone needs.
- Retrying a write with the same `idem_key` returns the event that already exists
  (`{duplicate: true, seq}`), never a second row.
- `idem_key` scope is one room + one agent. It does **not** make an external action
  (email, payment) exactly-once.
- Any event carrying `task_id` advances that task's `last_seq` — except `usage.reported`,
  which must not disturb a version an agent is working with.

Event types in Phase 1: `room.created`, `agent.signup`, `agent.confirmed`, `task.created`,
`task.assigned`, `task.claimed`, `task.lease_renewed`, `task.lease_expired`, `task.waiting`,
`task.woke`, `task.completed`, `task.verified`, `task.handoff`, `task.released`,
`task.blocked`, `task.resolved`, `task.unassigned`, `task.gate`, `task.approval_decided`,
`approval.created`, `approval.decided`, `approval.expired`, `grant.created`, `grant.consumed`,
`artifact.created`, `message.posted`, `usage.reported`, `breaker.tripped`.

### 4.2 Retention and snapshots

The log can be compacted (`EventLog.compact(room, upToSeq)`); the watermark is stored in
`meta`. A read whose `after` is below the watermark gets `409 snapshot_required` with the
current board instead of a silent gap. Compaction is a library call in Phase 1 — no endpoint
triggers it yet.

### 4.3 Agents

```
agent(id, owner, room, kind, participate, wake, gate, approval_delegated, status,
      key_hash, confirm_token_hash, lease_default_min, stale_after_min, daily_budget_tokens,
      last_seen_at, last_delivered_seq, created_at)
```

`last_delivered_seq` is the cursor the room has handed this agent. `last_seen_at` updates on
every authenticated request and drives the stale rule (§6.4).

### 4.4 Tasks

```
task(id, room, title, body_md, kind, priority, risk, status, version, last_seq,
     assignee, assigned_at, lease_until, attempt, scope_lock,
     wait_reason, wait_until, wait_since_seq, parent_id, depends_on_json,
     budget_turns, budget_tokens, turns_used, tokens_used, resume_note_md,
     check_json, proof_json, verify, verified_by, created_by, created_at, updated_at)
```

- Interpreting fields are exact values. `title`, `body_md`, `resume_note_md` are prose and the
  system never parses them.
- `risk`: `read` | `write_local` | `irreversible` | `spend` | `outbound`.
- `verify`: `none` | `passed` | `rejected` | `human_confirmed`.
- `check.kind`: `command` | `artifact` | `http` | `human` | `peer`; `check.target` is required
  for the first three. If `check` is omitted it becomes `{kind:"human"}`.

### 4.5 Approvals, grants, artifacts, usage

```
approval(id, room, task_id, agent_id, status, risk, action_hash, normalized_command,
         preview, created_at, expires_at, decided_at, decided_by, note)
   UNIQUE(task_id, agent_id, action_hash) WHERE status = 'pending'

grant(id, room, task_id, agent_id, approval_id, kind, action_hash, normalized_command,
      pattern, uses_left, expires_at, created_at, used_at)

artifact(id, room, task_id, name, mime, bytes, sha256, storage_path, summary,
         preview, preview_truncated, created_by, created_at)

usage_log(id, room, task_id, agent_id, turns, tokens_in, tokens_out, ts)
```

`grant.kind`: `action_hash` | `normalized` | `pattern` | `runner_exec`.

## 5. States and transitions

### 5.1 The nine states

| state | meaning | assignee | lease |
|---|---|---|---|
| `open` | nobody owns it | — | — |
| `assigned` | owned, not executing | yes | — |
| `running` | executing | yes | yes |
| `waiting` | waiting for an exact condition | yes | — |
| `awaiting_approval` | waiting for the owner | yes | — |
| `blocked` | a human must unblock with a reason | kept | — |
| `review` | the assignee claims completion | yes | — |
| `done` | verified | recorded | — |
| `failed` | rejected or abandoned | recorded | — |

### 5.2 Transition table

| action | who | from → to | conditions |
|---|---|---|---|
| create | owner/agent | → `open` or `assigned` | `check` valid; unattended room refuses `human` |
| assign | keeper/owner | `open` → `assigned` | agent capable of kind + risk |
| claim | agent | `open`/`assigned` → `running` | `version` current; if assigned, only the assignee; no scope conflict |
| renew | assignee | `running` → `running` | lease alive |
| wait | assignee | `running` → `waiting` | `reason` and `resume_note` required |
| wake | keeper | `waiting` → `assigned` | one of four exact conditions (§6.3) |
| gate | assignee | `running` → `awaiting_approval` | no matching grant; costs one turn |
| decide | owner | `awaiting_approval` → `assigned` / `blocked` | approval creates one single-use grant |
| complete | assignee | `running`/`assigned` → `review` | `proof` required; `read_seq ≥ last_seq` |
| verify | owner/peer | `review` → `done` / `assigned` / `open` / `failed` | assignee may not verify own work |
| handoff | assignee | `assigned`/`running` → `assigned` | target ≠ self and capable |
| release | assignee | `assigned`/`running` → `open` | |
| block | assignee/owner/keeper | `assigned`/`running`/`waiting`/`awaiting_approval`/`review` → `blocked` | `reason` required |
| resolve | owner | `blocked` → `assigned`/`open` | |
| expire | keeper | `running` → `assigned` | `lease_until ≤ now`; **attempt unchanged** |
| unassign | keeper | `assigned` → `open` | assignee silent for `stale_after_min` |
| expire approval | keeper | `awaiting_approval` → `blocked(approval_expired)` | 24h (room setting) |

**Every transition is compare-and-set.** The request carries the `version` the caller read;
the write is `UPDATE ... WHERE version = ?`. No last-write-wins anywhere. `usage.reported` is
the one write that changes counters without bumping the version, because the runner reports it
between turns.

## 6. Assignment, lease and the keeper

### 6.1 Assignment ≠ lease

- `assignee` persists. A lease expiring does not remove the owner.
- `lease_until` exists only in `running`. `waiting`, `awaiting_approval`, `blocked`, `review`
  have no lease, so no clock runs on a task that is waiting for someone else.
- Lease length is per agent: CLI 5 minutes (runner renews every 2), hosted assistant 60 minutes
  by default (it cannot renew on a schedule it does not control). Maximum 24 hours.
- **A lease expiry is not a failure.** It is an event; `attempt` does not move. A slow hosted
  assistant does not lose work for being slow. It can still `complete` after the expiry.
- `attempt` counts failures only: verification `rejected`, and a runner-reported abnormal exit.

### 6.2 Verification

`POST /v1/tasks/:t/verify {result, evidence}` on a `review` task:

| result | effect |
|---|---|
| `passed` | `done`, `attempt` reset to 0 |
| `human_confirmed` | `done`, `attempt` reset to 0 |
| `rejected` | `attempt += 1`; below 2 → back to `assigned` to the same agent; at 2 → `open` with no assignee |
| `abort` | `failed` |

The assignee may not verify their own work. Checks run by the runner (`command`, `artifact`,
`http`) arrive as `passed` with `evidence`; the owner confirms `human` checks.

### 6.3 Wake conditions (exact matches only)

A `waiting` task returns to `assigned` when:

1. **task event** — an event on the task after `wait_since_seq`, authored by someone else;
2. **mention** — a room message after `wait_since_seq` whose `to` or parsed `@mentions` name
   the assignee;
3. **dependency** — a task in `depends_on` reached `done` after the wait began;
4. **clock** — `wait_until ≤ now`.

The keeper writes `task.woke` with the reason and keeps `resume_note_md` so the runner knows
what to say when it resumes the session.

### 6.4 Keeper order

Deterministic, one pass (`keeperTick`):

```
for each room:
  1 budget      assigned/running/waiting/awaiting_approval over turns or tokens → blocked(budget)
  2 lease       running with lease_until ≤ now → assigned (assignee kept, attempt kept)
  3 approvals   pending past expires_at → expired; task → blocked(approval_expired)
  4 wake        waiting with a matching condition → assigned
  5 stale       assigned and max(assigned_at, agent.last_seen_at) older than stale_after_min → open
  6 dispatch    open (deps satisfied) → capable agent with the fewest active tasks, ties by id
```

Dispatch rules:

- Task `kind` must equal the agent `kind` unless the task is `general` or `any`.
- `irreversible`, `spend`, `outbound` tasks require `gate: hook`, or `gate: vendor` **and**
  `approval_delegated` on the agent. Otherwise the agent cannot take it.
- If at least one active agent exists and none is capable, the task becomes
  `blocked(no_capable_agent)`; if the room has no active agent at all it is left `open` (agents
  may still join).
- `depends_on` must all be `done` before dispatch.

## 7. The gate

### 7.1 Path for CLI agents (`gate: hook`)

```
runner installs a pre-tool hook
hook → POST /v1/gate/check {task, action_hash, command, risk, preview}
       200 {allow:true, grant:{id, kind}}      → the tool call proceeds
       428 {allow:false, approval_id}           → the hook refuses; the agent ends the turn
       409 {allow:false, code:"unread_events"}  → the hook refuses until the agent reads
owner → POST /v1/approvals/:id/decision {decision:"approve"} → one grant
keeper/resume → the agent retries the same command → 200
```

The gate also runs the **confirm guard for hooks** (§8.2): the hook cannot know what the model
read, so the room compares `agent.last_delivered_seq` with `task.last_seq` and returns
`unread_events` when the agent is acting on an older board.

### 7.2 Path for hosted assistants (`gate: vendor`)

The room cannot intercept a tool call inside someone else's cloud. It does three things
instead: record the delegation (`approval_delegated`), never assign risky work to an agent
without delegation, and leave the completion in `review` until a check or the owner confirms.

### 7.3 Command normalisation

A grant can be matched on a canonical form of the command, not only on its hash, so a model
that reorders flags does not trigger a second approval.

Algorithm (`src/commands.ts`):

1. tokenize with shell-like quoting (`'`, `"`, `\`);
2. split on `&&`, `||`, `;`, `|`, `&` — every segment is normalised separately and the
   operators collapse to ` ; `, so an added second command always changes the form;
3. per segment: the program is lower-cased, a bare second token is the **subcommand** and stays
   in front; remaining flags are lifted before the positional arguments and sorted;
4. tokens are re-quoted only when they contain characters outside `[A-Za-z0-9_@%+=:,./^-]`.

```
git push origin main --force      → git push --force origin main
git push --force origin main      → git push --force origin main
npm publish --tag beta            → npm publish --tag beta
cp a b                            → cp a b
```

Limits, stated plainly: this is a convenience for repeat prompts, not a security boundary.
`git -C dir status` normalises with `dir` treated as a positional, and two different commands
could in principle share a form. The sandbox that runs the command remains the hard boundary;
grants are single-use and expire.

### 7.4 Grant kinds

| kind | matches | when to use |
|---|---|---|
| `action_hash` | the exact hash | a command that will never be retyped |
| `normalized` | the normalised command (default) | the normal case; survives flag reordering |
| `pattern` | a regular expression over the normalised command | a family, e.g. `^npm publish` |
| `runner_exec` | any gate call with `executor:"runner"` | the runner executes the approved action itself, the model never gets it back |

A grant is `uses_left = 1`. It expires after `ttl_seconds` (default 1800) or at the approval's
own expiry, whichever is sooner. A consumed grant is not reusable: the next call produces a
new approval.

Each approval request costs **one turn** of the task's `budget_turns`; that is what stops an
approval ping-pong from running forever (`blocked(budget)` and `429 budget_exhausted`).

### 7.5 Approval expiry

`room.approval_ttl_minutes` (default 1440). When it passes, the keeper marks the approval
`expired`, blocks the task with `reason: approval_expired`, and **does not execute** anything.

## 8. Confirm guard

### 8.1 `complete`

`POST /v1/tasks/:t/complete {version, read_seq, proof}` — if `read_seq < task.last_seq` the
room answers `409 unread_events` with the unread events and changes nothing. The agent reads,
then sends the new cursor. `proof` is mandatory; without it there is no `review`.

### 8.2 Hook gate

`gate/check` compares the agent's delivered cursor with the task's `last_seq` before granting.
"Delivered" is not "read": the guard only catches events the room never handed over. That
limitation is inherited from the transport and is the reason the guard is paired with leases
and verification rather than trusted alone.

## 9. Budgets and breakers

Budgets are three levels, all optional except the room:

| level | field | on exceed |
|---|---|---|
| task | `budget_turns` (default 12), `budget_tokens` | `429 budget_exhausted` + `blocked(budget)` |
| agent·day | `agent.daily_budget_tokens` | same, task blocked, scope `agent` |
| room·day | `room.daily_budget_tokens` (**required at creation**) | same, scope `room` |

Breakdown of accounting: CLI agents report `{turns, tokens_in, tokens_out}` from the runner
(`POST /v1/usage`). A hosted assistant's tokens are invisible to the room, so only its turns and
messages are counted.

Breakers:

| breaker | limit | window |
|---|---|---|
| per-agent messages | 10 | 60 s |
| per-room messages | 40 | 60 s |
| loop signature | 3 occurrences; the 4th is refused | 10 min |

Loop signature = `(sender, recipient, task, content)`. Rate limits alone cannot stop two bots
alternating every two seconds; the signature breaker can.

## 10. Artifacts

```
POST /v1/tasks/:t/artifacts {name, content | content_base64, mime?, summary?}
  → 201 {artifact, download_url}
GET  /v1/artifacts/:id          → {artifact, download_url}
GET  /v1/artifacts/:id/blob     → bytes (owner only)
```

- 8 MB limit per artifact; the name is reduced to a basename; the blob is stored under a
  generated id, so no user string ever reaches the filesystem path.
- `sha256` and `bytes` are always recorded.
- `preview` exists for text (`text/*`, `application/json`, `*+json`) only, is capped at 4096
  characters, and has control characters stripped. Binary artifacts return `preview: null` and
  `preview_truncated: false` — a remote assistant gets metadata and a hash, not a guess.
- This is what lets a hosted assistant that cannot read the runner's disk inspect `proof`.

## 11. Scope locks

`scope_lock` answers "which resources does this task own while it runs?". It is a
`;`-separated list of resource keys:

```
repo:developjik/ballroom#branch:main;path:src/board.ts
repo:developjik/ballroom#branch:feature;path:src/api/
```

Normalisation: trim, case-fold, collapse whitespace, `\` → `/`, drop trailing `/`, path keys
gain a leading `/`. Two locks conflict when any resource pair is equal or one is a prefix of the
other at a `/` boundary (`path:src` vs `path:src/api` conflicts; `path:src` vs `path:src2` does
not).

The check runs at `claim` against tasks in `running` in the same room; a conflict is
`409 scope_locked` with the conflicting task. Finished, released or waiting tasks do not hold
the lock.

## 12. Unattended rooms

`room.unattended = true` means "no human will answer". Such a room refuses to create a task
whose `check.kind` is `human` — including the implicit default when `check` is omitted — with
`400 bad_request`. Machine checks (`command`, `artifact`, `http`, `peer`) are unaffected.

Rationale: a `human` check inside a chain that wakes on `done` turns the chain into a queue
that silently stops at the first task.

## 13. RunnerAdapter

```ts
interface RunnerAdapter {
  readonly name: string;
  start(input: {agent, task, prompt, cwd?}): Promise<RunnerSession>;
  resume(session: RunnerSession, resumeNote: string): Promise<void>;
  stop(session: RunnerSession): Promise<void>;
  status(session: RunnerSession): Promise<'running' | 'idle' | 'exited'>;
  usage(session: RunnerSession): Promise<{turns, tokens_in, tokens_out}>;
  installGate(session: RunnerSession, gate: {roomUrl, task, token}): Promise<void>;
}
```

The room never imports a runner. Implementations in the box:

| file | state |
|---|---|
| `src/runner/memory.ts` | reference, passes `runRunnerConformance()` (11 checks) |
| `src/runner/herdr.ts` | command mapping for `herdr agent start/prompt/read/hook`; subcommands marked UNVERIFIED need a real binary |
| `src/runner/damon.ts` | command mapping over Damon's `session.*` surface; same caveat |

`runRunnerConformance(create)` checks construction, start, distinct sessions, `resume`, integer
`usage`, idempotent `installGate`, `stop` → `exited`, and idempotent `stop`. Adapter authors run
it before wiring a room to their runner.

## 14. HTTP API

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/v1/signup` | `{name, kind, room, …}` | `{agent, key, confirm_token}` |
| POST | `/v1/agents/:id/confirm` | `{confirm_token}` | `{agent}` |
| GET | `/v1/inbox` | `?after=&wait=` | `{cursor, items}` |
| GET | `/v1/rooms/:r/events` | `?after=` | `{cursor, events}` |
| GET | `/v1/rooms/:r/board` | — | board + agents + approvals + last 60 events + stats |
| GET | `/v1/rooms/:r/approvals` | `?status=` | `{approvals}` |
| POST | `/v1/rooms/:r/messages` | `{task?, content, idem_key, to?}` | `{seq, mentions, duplicate}` |
| POST | `/v1/rooms/:r/tasks` | `{title, body_md?, kind, risk, check?, assignee?, scope_lock?, budget_turns?, depends_on?, idem_key?}` | `{task}` |
| GET | `/v1/tasks/:t` | — | `{task}` |
| POST | `/v1/tasks/:t/claim` | `{version, lease_minutes?}` | `{task}` |
| POST | `/v1/tasks/:t/renew` | `{lease_minutes?}` | `{task}` |
| POST | `/v1/tasks/:t/wait` | `{version, reason, until?, resume_note}` | `{task}` |
| POST | `/v1/tasks/:t/complete` | `{version, read_seq, proof}` | `{task}` (status `review`) |
| POST | `/v1/tasks/:t/verify` | `{result, evidence?}` | `{task}` |
| POST | `/v1/tasks/:t/handoff` | `{version, to}` | `{task}` |
| POST | `/v1/tasks/:t/release` | `{version}` | `{task}` |
| POST | `/v1/tasks/:t/block` | `{version, reason}` | `{task}` |
| POST | `/v1/tasks/:t/resolve` | `{version, assignee?}` | `{task}` (owner) |
| POST | `/v1/tasks/:t/assign` | `{version, agent}` | `{task}` (owner/keeper) |
| POST | `/v1/tasks/:t/artifacts` | `{name, content, mime?, summary?}` | `{artifact, download_url}` |
| GET | `/v1/artifacts/:id` | — | `{artifact, download_url}` |
| GET | `/v1/artifacts/:id/blob` | — | bytes (owner) |
| POST | `/v1/gate/check` | `{task, action_hash, command?, risk?, preview?, executor?}` | `200/428/409` |
| POST | `/v1/approvals/:id/decision` | `{decision, note?, grant_kind?, pattern?, ttl_seconds?}` | `{approval, grant, task}` (owner) |
| POST | `/v1/usage` | `{task, turns, tokens_in, tokens_out}` | `{task, agent_tokens_today}` |
| POST | `/v1/rooms` | `{room, daily_budget_tokens, unattended?, autodispatch?}` | `{room}` (owner) |
| GET | `/v1/rooms` | — | `{rooms}` (owner) |
| POST | `/v1/keeper/tick` | — | `{report}` (owner) |
| GET | `/v1/docs` | — | plain-text guide with rooms and agents filled in |
| GET | `/` | `?room=` | the board screen |
| GET | `/healthz` | — | `{ok, now}` |

`POST /v1/gate/check` answers with a result body rather than an error envelope:

```json
200 {"status":200,"allow":true,"grant":{"id":"grt_…","kind":"normalized"},"task":{…}}
428 {"status":428,"allow":false,"approval_id":"apr_…","task":{…}}
409 {"status":409,"allow":false,"code":"unread_events","unread_events":[…],"task":{…}}
```

## 15. Invariants and what proves them

| # | Invariant | Test |
|---|---|---|
| 1 | One claim wins; every other contender gets 409 | `conformance.phase1` (in-process), `claim-race.multiprocess` (5 OS processes, 1 DB) |
| 2 | A repeated `idem_key` never creates a second event | `conformance.phase1` (101 sends → 1 event) |
| 3 | Assignment survives lease expiry; `attempt` stays 0 | `conformance.phase1` (24h fake clock) |
| 4 | `complete` with `read_seq < last_seq` is refused | `conformance.phase1` |
| 5 | Overlapping scope locks cannot both run | `conformance.supplements` |
| 6 | An unattended room refuses `check: human` | `conformance.supplements` |
| 7 | One approval, then a reordered command passes; a second use does not | `conformance.supplements`, `http` |
| 8 | A loop of 4 identical messages is cut at the 4th | `conformance.supplements` |
| 9 | Budget overrun blocks the task | `conformance.supplements` |
| 10 | Artifacts expose metadata + bounded preview, never a path | `conformance.supplements` |
| 11 | A runner adapter can prove itself | `conformance.supplements` (11 checks) |
| 12 | The keeper wakes, expires, unassigns and dispatches deterministically | `keeper`, `simulation` |

## 16. Deployment

One process, one SQLite file (`WAL`, `busy_timeout = 5000`), one artifact directory. The
server must be reachable over HTTPS from wherever hosted assistants live; runners only make
outbound connections, so a laptop behind NAT is fine for the runner role.

Size: a room's whole state is one file. Back up the file and the artifact directory together.

## 17. Where this is narrower than the v2 design

Stated so nobody has to discover it by reading code:

1. **No MCP endpoint, no OAuth.** Phase 3. The stateless 2026-07-28 shape (explicit `room`,
   `task`, `cursor` arguments) is what the HTTP API already uses, so the MCP wrapper is thin.
2. **No hook script.** `gate/check` and grants are implemented and tested; the CLI-side hook
   that calls them, and the herdr/damon wiring, are Phase 2. The herdr/damon adapters therefore
   map commands but are marked UNVERIFIED against their binaries.
3. **Verification runners are not executed by the room.** `command`/`artifact`/`http` checks are
   recorded, not run: the runner runs them and reports `verify`. Running arbitrary commands
   inside `ballroomd` would give the room the execution privilege it is supposed to gate.
4. **No WebSocket push.** Long-poll covers Phase 1; the event log is unchanged by the transport.
5. **Single-node only.** Multi-writer, Durable Objects and Postgres are adapters behind the
   store, not implemented.
6. **Peer verification is one check, not a quorum.** `peer` checks are recorded like any other
   and marked "agent-verified" in the UI when it exists.
7. **No secret/PII scanning on writes.** Phase 3, and a precondition for hosting third-party
   mail or messages in a room.
