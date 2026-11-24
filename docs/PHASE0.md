# Phase 0 — experiments, and what the simulation actually shows

The design's Phase 0 has three experiments. Two of them need hardware this repository does not
have (real CLI agents, a hosted assistant's OAuth), so this document separates **what was
measured** from **what still needs a machine**.

Reproduce everything below with:

```bash
npm test                 # 61 tests (35 kernel + 26 for the hook, the installer, the CLI runner and the worker)
npm run sim:phase0
./scripts/verify-phase0-mac.sh   # the hook experiment on this machine (Phase 2)
```

---

## 0. Prior art this design reacts to

| Source | What it says | What ballroom does about it |
|---|---|---|
| MCP `2026-07-28` ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)) | stateless: no `initialize`, no session id, every request carries `_meta`; `server/discover`, `subscriptions/listen`, MRTR | every state handle is an explicit argument (`room`, `task`, `cursor`), so the Phase 3 MCP wrapper is thin and stateless |
| A2A `1.0` | `Task`, `Message`, `Artifact`, `AgentCard`, `contextId`, SSE and webhook push, opaque execution | task/artifact vocabulary matches; ballroom keeps its own board rather than adopting A2A's transport |
| Agent Board (arXiv 2611.04100) | a board with dependency edges beats a chat log for multi-agent work; polling cost grows with wait length | board is truth, wake is exact-match, long-poll is a first-class wait |
| "Worse Together" (Anthropic, 2026-11-11) | agents confirm before reading everything; a confirmation guard recovered 62–73% of those failures | the confirm guard (`409 unread_events`) on `complete` and on the hook gate |
| MAST | verification absence 8.2%, inaccurate verification 9.1% | `review` → `done` needs a check or the owner; the assignee cannot verify itself |
| Crosswalk | hosted board with tasks, claims, leases, evidence, idempotency, owner approvals | ballroom does not claim those; it claims public server code, execution-side enforcement, public conformance tests |

---

## 1. Experiment 1 — does a hook actually block `git push`?

**Status: the hook is shipped; the room half and the hook process are measured. Whether a given
vendor CLI obeys exit 2 in a headless run is still the one thing this repository cannot prove for
you.**

The gate half was already implemented and tested: `POST /v1/gate/check` returns `428` without a
grant, the owner decision creates one single-use grant, and the retry passes — including when the
model reorders the flags (`tests/conformance.supplements.test.ts`).

Phase 2 adds the other half: `src/hook/cli.ts` is the process a CLI runs before a tool call.
`tests/hook.process.test.ts` spawns it as a real child process against a real `ballroomd` and
asserts the exit codes and the exact stderr a model would read:

| situation | exit | what the model is told |
|---|---|---|
| `npm test`, `ls`, a file edit | 0 | nothing (no network call at all) |
| `git push --force`, `gh pr merge`, `npm publish` without a grant | 2 | the approval id, the `POST` that approves it, the board URL, "the grant is single-use" |
| approved, but the agent has not read the decision | 2 | the unread `seq` numbers and the inbox URL |
| room unreachable | 2 | the error, and that `--fail-open` exists |
| the event on stdin is not JSON | 2 | that the event could not be read |

`./scripts/verify-phase0-mac.sh` runs the same chain end to end on the machine: start `ballroomd`
on a throwaway port, create a room and an agent, claim a task, run the real hook (exit 2), approve
through the API, watch the confirm guard refuse the retry until the agent reads, then watch the
same command pass — and delete the database on the way out. `--full` adds the worker E2E.

What is still unproven, and why it cannot be proven here: that Claude Code itself refuses the tool
call when its `PreToolUse` hook exits 2 in a non-interactive run, and whether it needs a per-hook
trust confirmation or collides with an existing `~/.claude` configuration. The hook now exists and
prints the right thing; the vendor's obedience is the experiment left to the machine that runs it.

If it cannot block, the fallback is unchanged: the sandbox around the runner denies the action,
and the gate becomes advisory.

## 2. Experiment 2 — does an assignment survive 24 hours?

**Status: measured. `npm run sim:phase0` replays it on a fake clock.**

This is the experiment that motivated separating assignment from lease: in the first design a
task that waited 120 seconds lost its assignee. In the current model an agent can hold a task
overnight, lose the lease at minute 5, and still own the task — with `attempt` untouched.

## 3. Experiment 3 — can a hosted assistant connect?

**Status: not run here. Needs Phase 3 (MCP endpoint) and a Pally/Instinct account.**

The room is already built for the narrowest client: HTTP with a bearer key, JSON bodies, an
empty long-poll answer of exactly `{cursor, items: []}`, and artifacts with text previews so an
assistant that cannot read the runner's disk can still inspect `proof`.

What remains unknown: whether Pally can attach a custom MCP server at all, which protocol
generation it speaks, and how OAuth would be completed by an assistant with no browser.

---

## 4. Simulation results

`npm run sim:phase0` — fake clock starts 2026-11-24T09:00:00Z, 5 CLI agents and 1 hosted
assistant, in-memory SQLite.

| # | question | observed | result |
|---|---|---|---|
| 1 | 5 agents claim the same open task | 1 winner (a1) | PASS |
| 2 | same `idem_key` sent 101 times | 100 duplicates recognised, 1 event stored | PASS |
| 3 | 24h of fake time with a 5 minute lease | `status=assigned assignee=a2 attempt=0` | PASS |
| 4 | lease expiry events recorded | 1 `task.lease_expired` | PASS |
| 5 | two tasks with overlapping scope locks claim at once | second claim blocked | PASS |
| 6 | risky action without a grant | `428` | PASS |
| 7 | owner approves once; agent retries with flags reordered | `grant_kind=normalized`, retry `200`, reuse `428` | PASS |
| 8 | `complete` with an unread event on the task | `409 unread_events`, succeeds after reading | PASS |
| 9 | the same message repeated four times | 3 accepted, 4th `loop_detected` | PASS |
| 10 | usage report over the task turn budget | `429 budget_exhausted`, task `blocked` | PASS |
| 11 | hosted assistant claims a 60 minute lease, goes quiet for 25h | `assigned`, assignee kept, `attempt=0` | PASS |
| 12 | unattended room creates `check.kind="human"` | refused `400` | PASS |
| 13 | keeper dispatches an open task | assigned to the least busy agent | PASS |
| 14 | runner adapter conformance (memory reference) | 11/11 checks | PASS |
| 15 | approval left pending for 25h | approval `expired`, task `blocked(approval_expired)` | PASS |
| 16 | keeper decisions are in the event log | 22 keeper events | PASS |

`16/16 observations passed.`

### What the numbers mean

- **Approvals per risky action: 1.** Before normalisation a model that reorders `--force` would
  have needed a second approval, spending a turn of the task budget each time. With a normalised
  grant the retry passes; the second use of the same grant is refused (`428`), so the grant is
  still exactly one action.
- **Duplicate events from 100 retries: 0.** Idempotency is a unique index, not a convention.
- **Lease expiries counted as failures: 0.** `attempt` only moves on a rejected verification or
  a reported abnormal exit.
- **Concurrent claim winners: 1 of 5**, also verified with five separate OS processes against a
  single SQLite file (`tests/claim-race.multiprocess.test.ts`).

### What would falsify this design

1. Claude Code / Codex hooks cannot block a tool call in non-interactive runs → approval path 1
   collapses to the sandbox.
2. A hosted assistant cannot hold a 60-minute lease without renewing → hosted tasks need a
   different lease model (heartbeat by message, not by request).
3. Owners stop answering approvals → the 24h expiry blocks tasks, and the room becomes a queue
   that silently stops. The board has to make that visible (Phase 4).

---

## 5. Phase 2 — what was added, and what each piece proves

| piece | what it does | what proves it |
|---|---|---|
| `src/hook/` | reads a `PreToolUse` (or generic) event, classifies the command, calls the gate, turns the answer into exit 0/2 and the words a model needs | `tests/hook.process.test.ts` (8 tests, real processes) |
| `src/hook/install.ts`, `scripts/install-hooks.ts` | merges one hook into `.claude/settings.local.json` without touching anything else; writes `.ballroom/gate.json` 0600; uninstalls exactly its own entry | `tests/hook.install.test.ts` (6 tests) |
| `src/worker/` | long-poll → claim → installGate → run → renew → usage → artifact → complete; waits out an approval and resumes | `tests/worker.e2e.test.ts` (3 tests) |
| `src/runner/cli.ts` | a real child CLI: start, steer a live turn over stdin, resume a finished one, stop, usage, artifacts | `tests/runner.cli.test.ts` (9 tests, incl. `runRunnerConformance`) |
| `src/runner/damon.ts` | corrected to the CLI that exists (`damon prompt/sessions/usage`) | argv tests; **no daemon here** |

### What the worker E2E actually observed

One task, real HTTP, real child processes, a mock CLI that obeys the hook like a model would:

```
task assigned → worker long-polls → claim → hook 428 → the turn ends
→ task awaiting_approval → owner approves (grant kind normalized, uses 1)
→ worker reads the events the decision wrote → claim again → resume the CLI
→ hook 200 (the reordered retry reuses the grant) → out/evidence.md written
→ artifact uploaded (name, bytes, sha256, preview) → complete → review
→ owner verifies → done
```

Asserted along the way: exactly one approval for the whole task; the event order
(`task.gate` → `approval.created` → `task.approval_decided` → `grant.created` → `grant.consumed` →
`artifact.created` → `task.completed`); `turns_used ≥ 2` (the blocked turn is a real turn); and a
second task assigned to another agent is left alone.

### One correction carried over from Phase 1

`src/runner/damon.ts` used to call `damon session create --project …`. That subcommand does not
exist. Checked against `developjik/damon-agent-core` v0.9.0 (`src/bin/damon.rs` and `src/rpc.rs`),
the mapping is now: `damon prompt <text> --backend <agent> --json`, `damon sessions --json` to
find the session id (the CLI does not print it), `damon usage --session <id> --json`, and
`/cancel` on stdin before SIGTERM. Damon reports context size and cost, not an input/output token
split, so the adapter reports `tokens_in/out = 0` instead of inventing them — the room's turn
budget still applies.
