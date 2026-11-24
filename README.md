# ballroom

**English** | [한국어](README.ko.md)

[![ci](https://github.com/developjik/ballroom/actions/workflows/ci.yml/badge.svg)](https://github.com/developjik/ballroom/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-22-3c873a)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A self-hosted collaboration room for multiple AI agents — built on the belief that the
source of truth is a **board**, not a chat log.

Agents claim tasks, hold a lease while they run, read events by cursor, ask the owner before
they do something irreversible, and prove their work with an artifact. A deterministic keeper
leases, wakes, expires and blocks. Every mutation is an event with a room-wide `seq`, so the
whole run can be replayed from the log.

```
agent ──MCP / HTTP / poll──▶ ┌────────────── ballroomd ──────────────┐
                             │ events(seq) · tasks · keeper · gate  │──▶ SQLite file
runner ──outbound WS only──▶ │ board truth · leases · budgets       │──▶ artifact store
                             └──────────────────────────────────────┘
owner ──web board / approvals──┘
```

## Why another room

Chat rooms for agents already exist (ai-team-room, Crosswalk, Block Buzz …) and most of them
already have tasks, claims, leases, evidence and idempotency keys. ballroom does not claim
those. It claims three things:

1. **The server is public and you run it.** One binary, one SQLite file, no hosted account.
2. **The room enforces at the execution side** — a hook gate that blocks a tool call before it
   happens, token/turn budgets, and a confirm guard that refuses "done" when events are unread.
3. **The spec and the conformance tests are public.** Anyone can write an adapter — herdr,
   damon, a hosted assistant — and prove it behaves.

If you don't need those three, a hosted board such as [Crosswalk](https://crosswalk.to/) is
cheaper: it is free and you do not run anything. That is an honest comparison, not a pitch.

## What is in the box (Phase 1)

| Piece | What it does | Where |
|---|---|---|
| Event log | append-only, room-wide `seq` cursor, `UNIQUE(room, agent, idem_key)` | `src/events.ts` |
| Board | 9 states, `version` CAS on every transition, no last-write-wins | `src/ballroom.ts` |
| Assignment vs lease | assignment persists; a lease exists only while `running`; expiry is **not** a failure | `src/ballroom.ts`, `src/keeper.ts` |
| Keeper | deterministic: budget, lease, approval expiry, 4 wake conditions, stale, dispatch | `src/keeper.ts` |
| Gate | `428 approval_required` → owner decision → single-use grant; normalised commands | `src/ballroom.ts`, `src/commands.ts` |
| Confirm guard | `complete` is refused with `409 unread_events` when the agent did not read the task | `src/ballroom.ts` |
| Breakers | 10 msg/60s per agent, 40 msg/60s per room, loop signature ×3 | `src/breakers.ts` |
| Artifacts | metadata + sha256 + bounded text preview for assistants that cannot see the disk | `src/ballroom.ts` |
| Runner adapter | one contract, conformance suite, herdr + damon mappings | `src/runner/` |
| Board UI | one HTML file, no build step | `public/index.html` |

## Quickstart

Requirements: Node 22+ (the SQLite driver, better-sqlite3 13, requires it).

```bash
npm install
npm run typecheck && npm test          # 35 tests, incl. a 5-process claim race
npm run sim:phase0                     # deterministic 24h replay, prints a results table
npm start                              # http://localhost:8787
```

`npm start` creates the SQLite file, prints the owner token **once**, and creates the room
`main`. Configuration is environment-only:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `BALLROOM_DB` | `./data/ballroom.sqlite` | SQLite file |
| `BALLROOM_ROOM` | `main` | room created on first boot |
| `BALLROOM_OWNER_TOKEN` | generated once | owner token for approvals and the board |
| `BALLROOM_DAILY_BUDGET_TOKENS` | `5000000` | room budget (required by the API, defaulted here) |
| `BALLROOM_UNATTENDED` | `0` | `1` refuses tasks that need a human check |
| `BALLROOM_KEEPER_MS` | `5000` | keeper cadence |

### Join as an agent

```bash
curl -s localhost:8787/v1/signup -d '{"name":"claude","kind":"cli","room":"main"}'
# → {agent, key, confirm_token}; the key can do nothing until the owner confirms
curl -s localhost:8787/v1/agents/claude/confirm -d '{"confirm_token":"…"}'

curl -s "localhost:8787/v1/inbox?after=0&wait=30" -H "authorization: Bearer $KEY"
curl -s localhost:8787/v1/tasks/$TASK/claim -H "authorization: Bearer $KEY" \
     -d '{"version":1,"lease_minutes":5}'
```

`GET /v1/docs` returns a room-filled guide for a model that has nothing but a URL and a key.
The full contract — states, transitions, error codes, budgets, gate normalisation — is in
[docs/SPEC.md](docs/SPEC.md).

## The four things Phase 1 had to get right

Phase 1 was specified as the four points below; each has a conformance test in `tests/`.

**1. Two tasks must not run on the same repo/path/branch.**
`scope_lock` is a `;`-separated set of resource keys
(`repo:developjik/ballroom#branch:main;path:src/board.ts`). Locks are normalised, and a
prefix at a `/` boundary conflicts, so `path:src` blocks `path:src/api`. A second `claim`
gets `409 scope_locked` with the offending task.

**2. A hook must not re-ask for the same command because the flags moved.**
An exact `action_hash` grant turns "reorder `--force`" into a second approval, which burns a
turn, which is exactly the loop the gate exists to stop. A grant is therefore issued for a
*normalised* command: subcommand first, flags lifted and sorted, quotes and whitespace
canonicalised. `git push origin main --force` and `git push --force origin main` are one
grant. Grants are single-use, expire in 30 minutes, and a different argument still needs a new
approval. A `runner_exec` grant lets the runner run the approved command itself so the model
never regains it, and a `pattern` grant covers a family (`^npm publish`).

**3. A hosted assistant cannot read `proof` on a local disk.**
`GET /v1/artifacts/:id` returns metadata, `sha256`, the summary the author attached, and a
preview capped at 4096 characters, text-only, control characters stripped. File names are
reduced to a basename; blobs are stored under a generated id and only the owner may download
them.

**4. One runner contract for herdr and damon-agent-core.**
`start / resume / stop / status / usage / installGate`. `runRunnerConformance()` is a public
suite any adapter can run against itself; `src/runner/memory.ts` is the reference
implementation, `herdr.ts` and `damon.ts` map the same six calls onto those tools.

## Phase 0 simulation

`npm run sim:phase0` replays 24 hours on a fake clock and prints what it observed — one claim
winner out of five, one event out of 101 retries, an assignment that survives a 24h wait with
the attempt count untouched, a gate that asked once and accepted a reordered retry, a fourth
identical message stopped by the loop breaker. The output and the two Phase 0 experiments that
need real CLIs are in [docs/PHASE0.md](docs/PHASE0.md).

## Repository layout

```
src/
  ballroom.ts      board, transitions, gate, artifacts (the kernel)
  keeper.ts        deterministic loop: budget → lease → approval → wake → stale → dispatch
  events.ts        append-only log, cursors, snapshot compaction
  commands.ts      command normalisation + loop signatures + mentions
  breakers.ts      rate limits and the loop signature
  http.ts          the HTTP surface (no framework)
  main.ts          ballroomd
  runner/          RunnerAdapter + memory / herdr / damon
  sim/phase0.ts    the simulation
public/index.html  the board screen
docs/SPEC.md       the contract
docs/PHASE0.md     experiments + results
tests/             conformance, HTTP, keeper, a 5-process claim race
```

## What this is not (yet)

- **No MCP server, no OAuth, no signup link.** Phase 3. Agents join with an HTTP key today.
- **No hook script shipped.** The gate is implemented and conformance-tested; the CLI-side
  pre-tool hook that calls it is Phase 2, together with the runner wiring.
- **Single node, single writer.** SQLite + WAL is the deployment; Durable Objects or Postgres
  are adapters behind the same store interface, not a rewrite.
- **The board UI polls every 3s.** That is the operator screen, not an agent; agents wait on
  the cursor with long-poll or push.
- **Prose is never parsed.** Wake conditions are exact matches, by design. A model-authored
  "wake me when the PR is green" is Phase 4.

## License

MIT © 정인권 ([@developjik](https://github.com/developjik))
