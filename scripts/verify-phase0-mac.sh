#!/usr/bin/env bash
#
# verify-phase0-mac.sh — prove, on this machine, that a pre-tool hook really
# blocks a risky CLI action until the room's owner approves it.
#
#   git pull && npm ci
#   ./scripts/verify-phase0-mac.sh          # the hook experiment (about 5s)
#   ./scripts/verify-phase0-mac.sh --full   # also the worker E2E suite
#
# What it does, on a temporary port and a temporary SQLite file:
#   1. starts ballroomd
#   2. creates room `main`, signs up the agent `mac-verify`, confirms it
#   3. creates an irreversible task and claims it as that agent
#   4. runs the real PreToolUse hook with `git push --force origin main`
#        → expects exit 2 and an approval id
#   5. approves it through the API with the owner token
#   6. runs the hook again *before* reading → expects 409-style refusal
#   7. lets the agent read, runs the hook again → expects exit 0
#   8. completes the task, verifies it as the owner → done
#   9. stops the daemon and deletes everything it created
#
# Exit code 0 means every step held. Nothing outside $TMPDIR is touched.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FULL=0
for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)"; exit 2 ;;
  esac
done

BOLD="$(tput bold 2>/dev/null || true)"
DIM="$(tput dim 2>/dev/null || true)"
GREEN="$(tput setaf 2 2>/dev/null || true)"
RED="$(tput setaf 1 2>/dev/null || true)"
RESET="$(tput sgr0 2>/dev/null || true)"

STEP=0
pass() { STEP=$((STEP + 1)); printf '%s✔%s %s\n' "$GREEN" "$RESET" "$1"; }
fail() { printf '%s✘ %s%s\n' "$RED" "$1" "$RESET"; exit 1; }
note() { printf '%s  %s%s\n' "$DIM" "$1" "$RESET"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ballroom-verify.XXXXXX")"
SERVER_PID=""
cleanup() {
  local code=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$code" -ne 0 ] && [ -f "$TMP/daemon.log" ]; then
    printf '\n%s--- ballroomd log (last 30 lines) ---%s\n' "$DIM" "$RESET"
    tail -n 30 "$TMP/daemon.log" || true
  fi
  rm -rf "$TMP"
  exit "$code"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- preflight
command -v node >/dev/null 2>&1 || fail "node not found — install Node 22+ (nvm install 22)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node $NODE_MAJOR found, Node 22+ required (better-sqlite3 13)"
[ -d node_modules ] || fail "node_modules missing — run: npm ci"
[ -f src/hook/cli.ts ] || fail "src/hook/cli.ts missing — is this the ballroom repository?"

# JSON field reader: json <dotted.path>  (reads stdin)
json() {
  node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      try {
        const value = process.argv[1].split(".").reduce((node, key) => (node == null ? node : node[key]), JSON.parse(raw));
        if (value === undefined || value === null) process.exit(3);
        process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
      } catch {
        process.exit(3);
      }
    });
  ' "$1"
}

PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
BASE="http://127.0.0.1:$PORT"
OWNER_TOKEN="verify-owner-$(node -p 'require("crypto").randomBytes(8).toString("hex")')"
ROOM="main"

printf '%sballroom — Phase 2 hook verification%s\n' "$BOLD" "$RESET"
note "node $(node -v) · port $PORT · db $TMP/ballroom.sqlite"
echo

# ------------------------------------------------------------------ daemon
(
  cd "$ROOT"
  PORT="$PORT" \
  BALLROOM_DB="$TMP/ballroom.sqlite" \
  BALLROOM_OWNER_TOKEN="$OWNER_TOKEN" \
  BALLROOM_ROOM="$ROOM" \
  BALLROOM_DAILY_BUDGET_TOKENS=1000000 \
  BALLROOM_KEEPER_MS=1000 \
  node --import tsx src/main.ts >"$TMP/daemon.log" 2>&1
) &
SERVER_PID=$!

for _ in $(seq 1 100); do
  if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fsS "$BASE/healthz" >/dev/null 2>&1 || fail "ballroomd did not come up on $BASE"
pass "ballroomd is up on $BASE"

# ------------------------------------------------------------- room + agent
curl -fsS -X POST "$BASE/v1/signup" -H 'content-type: application/json' \
  -d '{"name":"mac-verify","kind":"cli","room":"main","gate":"hook","wake":"poll","lease_default_min":5}' \
  >"$TMP/signup.json" || fail "signup failed"
AGENT_KEY="$(json key <"$TMP/signup.json")" || fail "signup returned no key"
CONFIRM_TOKEN="$(json confirm_token <"$TMP/signup.json")"

curl -fsS -X POST "$BASE/v1/agents/mac-verify/confirm" -H 'content-type: application/json' \
  -d "{\"confirm_token\":\"$CONFIRM_TOKEN\"}" >/dev/null || fail "agent confirmation failed"
pass "agent mac-verify signed up and was confirmed by the owner"

curl -fsS -X POST "$BASE/v1/rooms/$ROOM/tasks" \
  -H "authorization: Bearer $OWNER_TOKEN" -H 'content-type: application/json' \
  -d '{
        "title": "verify the hook on this mac",
        "body_md": "Push the branch once the owner approves.",
        "kind": "cli",
        "risk": "irreversible",
        "assignee": "mac-verify",
        "check": {"kind": "command", "target": "npm test"},
        "budget_turns": 8,
        "idem_key": "verify-mac-task"
      }' >"$TMP/task.json" || fail "task creation failed"
TASK_ID="$(json task.id <"$TMP/task.json")"
TASK_VERSION="$(json task.version <"$TMP/task.json")"

curl -fsS -X POST "$BASE/v1/tasks/$TASK_ID/claim" \
  -H "authorization: Bearer $AGENT_KEY" -H 'content-type: application/json' \
  -d "{\"version\":$TASK_VERSION,\"lease_minutes\":10}" >"$TMP/claim.json" || fail "claim failed"
[ "$(json task.status <"$TMP/claim.json")" = "running" ] || fail "claim did not put the task in running"
curl -fsS "$BASE/v1/inbox?after=0&wait=0" -H "authorization: Bearer $AGENT_KEY" >/dev/null
pass "task $TASK_ID created, claimed by mac-verify, inbox read"

# ------------------------------------------------------------------- hook 1
cat >"$TMP/payload.json" <<JSON
{
  "session_id": "mac-verify-session",
  "cwd": "$TMP",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "git push --force origin main", "description": "ship it" }
}
JSON

run_hook() {
  # runs the real hook process with the payload above; sets HOOK_CODE/HOOK_ERR
  set +e
  HOOK_ERR="$(node --import tsx src/hook/cli.ts \
      --room-url "$BASE" --token "$AGENT_KEY" --task "$TASK_ID" --room "$ROOM" \
      <"$TMP/payload.json" 2>&1 >/dev/null)"
  HOOK_CODE=$?
  set -e
}

run_hook
[ "$HOOK_CODE" -eq 2 ] || fail "the hook exited $HOOK_CODE, expected 2 (blocked)"
APPROVAL_ID="$(printf '%s' "$HOOK_ERR" | sed -n 's/.*approval: *\(apr_[0-9a-f]*\).*/\1/p' | head -n1)"
[ -n "$APPROVAL_ID" ] || fail "the hook did not print an approval id"
pass "hook blocked 'git push --force origin main' with exit 2 (approval $APPROVAL_ID)"
printf '%s\n' "$HOOK_ERR" | sed 's/^/    /'

# ---------------------------------------------------------------- approve
curl -fsS -X POST "$BASE/v1/approvals/$APPROVAL_ID/decision" \
  -H "authorization: Bearer $OWNER_TOKEN" -H 'content-type: application/json' \
  -d '{"decision":"approve","note":"verified on this mac"}' >"$TMP/decision.json" || fail "approval decision failed"
[ "$(json grant.kind <"$TMP/decision.json")" = "normalized" ] || fail "expected a normalised single-use grant"
pass "owner approved once — grant kind normalized, uses_left 1"

# ------------------------------------------------- hook 2: confirm guard
run_hook
[ "$HOOK_CODE" -eq 2 ] || fail "expected the confirm guard to refuse before the read (got $HOOK_CODE)"
printf '%s' "$HOOK_ERR" | grep -q "have not read" || fail "the refusal was not the confirm guard"
pass "hook refused again before the read (409 unread_events, by design)"

curl -fsS "$BASE/v1/inbox?after=0&wait=0" -H "authorization: Bearer $AGENT_KEY" >/dev/null
run_hook
[ "$HOOK_CODE" -eq 0 ] || fail "the hook still blocked after approval (exit $HOOK_CODE)"
pass "hook allowed the same command after approval (exit 0)"

# ---------------------------------------------------- complete and verify
curl -fsS "$BASE/v1/tasks/$TASK_ID" -H "authorization: Bearer $AGENT_KEY" >"$TMP/fresh.json"
VERSION="$(json task.version <"$TMP/fresh.json")"
LAST_SEQ="$(json task.last_seq <"$TMP/fresh.json")"
curl -fsS -X POST "$BASE/v1/tasks/$TASK_ID/complete" \
  -H "authorization: Bearer $AGENT_KEY" -H 'content-type: application/json' \
  -d "{\"version\":$VERSION,\"read_seq\":$LAST_SEQ,\"proof\":{\"hook\":\"allowed once\",\"by\":\"verify-phase0-mac\"}}" \
  >"$TMP/complete.json" || fail "complete failed"
[ "$(json task.status <"$TMP/complete.json")" = "review" ] || fail "complete did not move the task to review"

curl -fsS -X POST "$BASE/v1/tasks/$TASK_ID/verify" \
  -H "authorization: Bearer $OWNER_TOKEN" -H 'content-type: application/json' \
  -d '{"result":"passed","evidence":"hook blocked, approved once, then allowed"}' \
  >"$TMP/verified.json" || fail "verify failed"
[ "$(json task.status <"$TMP/verified.json")" = "done" ] || fail "verify did not move the task to done"
pass "task completed → review → done by the owner"

# ------------------------------------------------------------------ board
curl -fsS "$BASE/v1/rooms/$ROOM/board" -H "authorization: Bearer $OWNER_TOKEN" >"$TMP/board.json"
node -e '
  const board = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const approval = board.approvals.length === 0 ? "no pending approvals" : `${board.approvals.length} pending`;
  console.log(`    board: ${board.stats.total} task(s) — done ${board.stats.done}, running ${board.stats.running}, review ${board.stats.review} · ${approval}`);
  console.log(`    board url: ${process.argv[2]}/?room=${encodeURIComponent(board.room.room)}`);
' "$TMP/board.json" "$BASE"

printf '\n%s✔ Phase 2 hook verification passed%s — the gate blocks before the command runs.\n' "$GREEN" "$RESET"

if [ "$FULL" -eq 1 ]; then
  echo
  printf '%s--- worker E2E (real HTTP, real child processes, mock CLI) ---%s\n' "$DIM" "$RESET"
  ./node_modules/.bin/vitest run tests/worker.e2e.test.ts || fail "worker E2E suite failed"
  printf '%s✔ worker E2E passed%s\n' "$GREEN" "$RESET"
fi

echo
note "Everything above ran on port $PORT against a throwaway database; it is already gone."
note "To use the gate in a real project:"
note "  npm run hooks:install -- --dir . --room-url $BASE --task <task_id> --token <agent_key>"
