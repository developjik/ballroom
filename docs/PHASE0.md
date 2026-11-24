# Phase 0 — experiments, and what the simulation actually shows

The design's Phase 0 has three experiments. Two of them need hardware this repository does not
have (real CLI agents, a hosted assistant's OAuth), so this document separates **what was
measured** from **what still needs a machine**.

Reproduce everything below with:

```bash
npm test          # 35 tests
npm run sim:phase0
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

**Status: not run here. Needs the runner machine.**

The gate half is implemented and tested: `POST /v1/gate/check` returns `428` without a grant,
the owner decision creates one single-use grant, and the retry passes — including when the model
reorders the flags (`tests/conformance.supplements.test.ts`).

What is not yet proven is the other half: that Claude Code and Codex actually refuse the tool
call when their pre-tool hook says no. The design already flags this as unverified, and it is
the one experiment that can invalidate approval path 1.

To run it (Phase 2):

1. install the hook for `pre_tool_use` in a non-interactive run (`codex exec`, Claude Code
   headless);
2. ask the agent to `git push --force` without approval;
3. record three things: whether the hook fires at all, whether the CLI needs a per-hook trust
   confirmation, and whether an existing `~/.codex/hooks.json` interferes;
4. if the hook cannot block, the fallback is the sandbox: the runner executes inside a
   filesystem/network policy that denies outbound writes, and the gate becomes advisory.

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
