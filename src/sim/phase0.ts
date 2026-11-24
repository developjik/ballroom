/**
 * Phase 0 / Phase 1 simulation — deterministic, no network, fake clock.
 *
 * Phase 0 of the design asks three questions (docs/PHASE0.md):
 *   1. does a hook actually block a risky CLI action?  (needs a real CLI; not here)
 *   2. does an assignment survive 24h with a fake clock?  ← this file
 *   3. can a hosted assistant connect?  (needs Pally/Instinct; not here)
 *
 * What is measured here is the board/kernel half of all three: the transition
 * table, lease vs assignment, the gate + single-use grant, the confirm guard,
 * the three breakers, and idempotency under retry.
 *
 *   npm run sim:phase0
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ballroom, KEEPER_ACTOR, type Actor } from '../ballroom.js';
import { MutableClock } from '../clock.js';
import { ApiError } from '../errors.js';
import { MemoryRunnerAdapter } from '../runner/memory.js';
import { assertRunnerConformance, runRunnerConformance } from '../runner/adapter.js';
import { sha256 } from '../util.js';

interface Observation {
  question: string;
  observed: string;
  ok: boolean;
}

const owner: Actor = { owner: 'owner', agent: null };

function ownerTokenFor(): string {
  return 'phase0-owner-token';
}

export async function runSimulation(): Promise<Observation[]> {
  const rows: Observation[] = [];
  const observe = (question: string, observed: string, ok: boolean) =>
    rows.push({ question, observed, ok });

  const clock = new MutableClock('2026-11-24T09:00:00.000Z');
  const dir = mkdtempSync(join(tmpdir(), 'ballroom-phase0-'));
  const b = new Ballroom({ dbFile: ':memory:', clock, ownerToken: ownerTokenFor(), artifactsDir: dir });
  b.createRoom({ room: 'sim', daily_budget_tokens: 2_000_000 });

  const agents: Record<string, string> = {};
  for (const name of ['a1', 'a2', 'a3', 'a4', 'a5']) {
    const { agent, confirm_token } = b.signup({
      name,
      kind: 'cli',
      room: 'sim',
      gate: 'hook',
      wake: 'push',
      stale_after_min: 2880,
    });
    b.confirmAgent(agent.id, confirm_token);
    agents[name] = agent.id;
  }
  const hosted = b.signup({
    name: 'pally',
    kind: 'hosted',
    room: 'sim',
    gate: 'vendor',
    wake: 'poll',
    approval_delegated: true,
    lease_default_min: 60,
  });
  b.confirmAgent(hosted.agent.id, hosted.confirm_token);
  const pally: Actor = { owner: 'owner', agent: 'pally' };

  const actorOf = (name: string): Actor => ({ owner: 'owner', agent: agents[name]! });
  const readAll = (name: string, after = 0) => {
    const actor = actorOf(name);
    return b.inboxOnce(actor, after).cursor;
  };

  // 1 — concurrent claims ---------------------------------------------------
  const contend = b.createTask(owner, 'sim', {
    title: 'contended task',
    kind: 'cli',
    risk: 'write_local',
    check: { kind: 'command', target: 'npm test' },
  });
  b.assign(owner, contend.id, { version: contend.version, agent: agents['a1']! });
  const winners: string[] = [];
  for (const name of ['a1', 'a2', 'a3', 'a4', 'a5']) {
    try {
      b.claim(actorOf(name), contend.id, { version: 2 });
      winners.push(name);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
    }
  }
  observe('5 agents claim the same open task', `${winners.length} winner(s): ${winners.join(',')}`, winners.length === 1);

  // 2 — idempotent retries --------------------------------------------------
  const idem = sha256('phase0-message');
  const first = b.postMessage(actorOf('a1'), 'sim', {
    content: 'status: starting the build',
    idem_key: idem,
  });
  let duplicates = 0;
  for (let i = 0; i < 100; i += 1) {
    const again = b.postMessage(actorOf('a1'), 'sim', {
      content: 'status: starting the build',
      idem_key: idem,
    });
    if (again.duplicate && again.seq === first.seq) duplicates += 1;
  }
  const storedEvents = b.store.one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE idem_key = ?`,
    idem,
  )!.n;
  observe(
    'same idem_key sent 101 times',
    `${duplicates} duplicates recognised, ${storedEvents} event(s) stored`,
    duplicates === 100 && storedEvents === 1,
  );

  // 3 — assignment survives a 24h wait; lease expiry is not a failure -------
  const long = b.createTask(owner, 'sim', {
    title: 'overnight task',
    kind: 'cli',
    risk: 'write_local',
    check: { kind: 'command', target: 'npm test' },
    assignee: agents['a2']!,
  });
  let longTask = b.claim(actorOf('a2'), long.id, { version: long.version, lease_minutes: 5 });
  const leaseBefore = longTask.lease_until;
  clock.advanceHours(24);
  b.keeper();
  longTask = b.requireTask(long.id);
  observe(
    '24h of fake time with a 5 minute lease',
    `status=${longTask.status} assignee=${longTask.assignee} attempt=${longTask.attempt} lease_before=${leaseBefore}`,
    longTask.status === 'assigned' && longTask.assignee === agents['a2'] && longTask.attempt === 0,
  );
  const expired = b.store.one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task.lease_expired'`,
    long.id,
  )!.n;
  observe('lease expiry events were recorded', `${expired} task.lease_expired event(s)`, expired === 1);

  // 4 — scope lock ----------------------------------------------------------
  clock.advanceMinutes(1);
  const lock = 'repo:developjik/ballroom#branch:main;path:src/board.ts';
  const one = b.createTask(owner, 'sim', {
    title: 'edit board.ts',
    kind: 'cli',
    risk: 'write_local',
    scope_lock: lock,
    check: { kind: 'command', target: 'npm test' },
  });
  const two = b.createTask(owner, 'sim', {
    title: 'edit board.ts again',
    kind: 'cli',
    risk: 'write_local',
    scope_lock: 'repo:developjik/ballroom#branch:main;path:src/board.ts/sub',
    check: { kind: 'command', target: 'npm test' },
  });
  let scopeBlocked = false;
  try {
    b.claim(actorOf('a3'), one.id, { version: one.version });
    b.claim(actorOf('a4'), two.id, { version: two.version });
  } catch (error) {
    scopeBlocked = error instanceof ApiError && error.code === 'scope_locked' && error.status === 409;
  }
  observe('two tasks with overlapping scope locks claim at once', `second claim blocked=${scopeBlocked}`, scopeBlocked);

  // 5 — gate + single-use, normalised grant ---------------------------------
  clock.advanceMinutes(1);
  const risky = b.createTask(owner, 'sim', {
    title: 'push the branch',
    kind: 'cli',
    risk: 'irreversible',
    check: { kind: 'artifact', target: 'docs/PHASE0.md' },
    assignee: agents['a1']!,
  });
  let riskyTask = b.claim(actorOf('a1'), risky.id, { version: risky.version, lease_minutes: 10 });
  let cursor = readAll('a1');
  const firstGate = b.gateCheck(actorOf('a1'), {
    task: risky.id,
    action_hash: sha256('git push origin main --force'),
    command: 'git push origin main --force',
    risk: 'irreversible',
  });
  observe(
    'risky action without a grant',
    `status=${firstGate.status} code=${'code' in firstGate ? firstGate.code : '-'}`,
    firstGate.status === 428,
  );
  const approvalId = firstGate.status === 428 ? firstGate.approval_id : '';
  riskyTask = b.requireTask(risky.id);
  const awaiting = riskyTask.status === 'awaiting_approval';

  const decision = b.decideApproval(owner, approvalId, { decision: 'approve' });
  cursor = readAll('a1');
  const reordered = b.gateCheck(actorOf('a1'), {
    task: risky.id,
    action_hash: sha256('git push --force origin main'),
    command: 'git push --force origin main',
    risk: 'irreversible',
  });
  const second = (() => {
    readAll('a1');
    return b.gateCheck(actorOf('a1'), {
      task: risky.id,
      action_hash: sha256('git push --force origin main'),
      command: 'git push --force origin main',
      risk: 'irreversible',
    });
  })();
  observe(
    'owner approves one command; the agent retries with flags reordered',
    `awaiting_approval=${awaiting} grant_kind=${decision.grant?.kind} retry_status=${reordered.status} reuse_status=${second.status} cursor=${cursor}`,
    awaiting &&
      decision.grant?.kind === 'normalized' &&
      reordered.status === 200 &&
      second.status !== 200,
  );


  // 6 — confirm guard -------------------------------------------------------
  clock.advanceMinutes(1);
  const guard = b.createTask(owner, 'sim', {
    title: 'confirm guard',
    kind: 'cli',
    risk: 'write_local',
    check: { kind: 'command', target: 'npm test' },
    assignee: agents['a3']!,
  });
  let guardTask = b.claim(actorOf('a3'), guard.id, { version: guard.version, lease_minutes: 10 });
  const staleRead = guardTask.last_seq;
  b.postMessage(actorOf('a1'), 'sim', {
    task: guard.id,
    content: 'please re-read the spec before you finish',
    idem_key: 'phase0-guard-1',
  });
  let unread = false;
  try {
    b.complete(actorOf('a3'), guard.id, { version: guardTask.version, read_seq: staleRead, proof: { ok: true } });
  } catch (error) {
    unread = error instanceof ApiError && error.status === 409 && error.code === 'unread_events';
  }
  readAll('a3');
  guardTask = b.requireTask(guard.id);
  const done = b.complete(actorOf('a3'), guard.id, {
    version: guardTask.version,
    read_seq: guardTask.last_seq,
    proof: { ok: true, test: 'npm test' },
  });
  observe(
    'complete with an unread event on the task',
    `409 unread_events=${unread}, after reading status=${done.status}`,
    unread && done.status === 'review',
  );

  // 7 — loop breaker --------------------------------------------------------
  clock.advanceMinutes(1);
  const accepted: number[] = [];
  let loopCode = '';
  for (let i = 0; i < 4; i += 1) {
    try {
      const posted = b.postMessage(actorOf('a4'), 'sim', {
        content: 'ping @a5',
        to: 'a5',
        idem_key: `phase0-loop-${i}`,
      });
      accepted.push(posted.seq);
    } catch (error) {
      if (error instanceof ApiError) loopCode = error.code;
    }
  }
  observe(
    'the same message repeated four times',
    `${accepted.length} accepted, fourth → ${loopCode}`,
    accepted.length === 3 && loopCode === 'loop_detected',
  );

  // 8 — budget --------------------------------------------------------------
  clock.advanceMinutes(1);
  const budget = b.createTask(owner, 'sim', {
    title: 'budgeted task',
    kind: 'cli',
    risk: 'write_local',
    budget_turns: 3,
    check: { kind: 'command', target: 'npm test' },
    assignee: agents['a5']!,
  });
  const budgetTask = b.claim(actorOf('a5'), budget.id, { version: budget.version, lease_minutes: 10 });
  void budgetTask;
  let budgetCode = '';
  try {
    b.reportUsage(actorOf('a5'), { task: budget.id, turns: 4, tokens_in: 500, tokens_out: 100 });
  } catch (error) {
    if (error instanceof ApiError) budgetCode = error.code;
  }
  const blocked = b.requireTask(budget.id);
  observe(
    'usage report over the task turn budget',
    `code=${budgetCode} status=${blocked.status} turns_used=${blocked.turns_used}`,
    budgetCode === 'budget_exhausted' && blocked.status === 'blocked',
  );

  // 9 — hosted assistant lease ---------------------------------------------
  clock.advanceMinutes(1);
  const hostedTask = b.createTask(owner, 'sim', {
    title: 'draft the release note',
    kind: 'hosted',
    risk: 'write_local',
    check: { kind: 'artifact', target: 'release.md' },
  });
  b.assign(owner, hostedTask.id, { version: hostedTask.version, agent: 'pally' });
  const poll = b.inboxOnce(pally, 0);
  const claimedByPally = b.claim(pally, hostedTask.id, { version: 2 });
  clock.advanceHours(25);
  b.keeper();
  const afterHosted = b.requireTask(hostedTask.id);
  observe(
    'hosted assistant polls, claims a 60 minute lease, goes quiet for 25h',
    `inbox_items=${poll.items.length} lease=${claimedByPally.lease_until} final_status=${afterHosted.status} assignee=${afterHosted.assignee} attempt=${afterHosted.attempt}`,
    afterHosted.status === 'assigned' && afterHosted.assignee === 'pally' && afterHosted.attempt === 0,
  );

  // 10 — unattended room refuses human checks -------------------------------
  const unattended = b.createRoom({ room: 'night-shift', unattended: true, daily_budget_tokens: 500_000 });
  let refused = false;
  try {
    b.createTask(owner, unattended.room, { title: 'needs a human', check: { kind: 'human' } });
  } catch (error) {
    refused = error instanceof ApiError && error.status === 400;
  }
  observe('unattended room creates a task with check.kind="human"', `refused=${refused}`, refused);

  // 11 — keeper dispatch ----------------------------------------------------
  clock.advanceMinutes(1);
  const dispatchable = b.createTask(owner, 'sim', {
    title: 'dispatch me',
    kind: 'cli',
    risk: 'write_local',
    check: { kind: 'command', target: 'npm test' },
  });
  const report = b.keeper();
  const dispatched = b.requireTask(dispatchable.id);
  observe(
    'keeper dispatches an open task',
    `report=${report.dispatched.length} assignee=${dispatched.assignee} status=${dispatched.status}`,
    dispatched.status === 'assigned' && !!dispatched.assignee,
  );

  // 12 — runner contract ----------------------------------------------------
  const checks = await runRunnerConformance(() => new MemoryRunnerAdapter());
  observe(
    'runner adapter conformance (memory reference)',
    `${checks.filter((c) => c.ok).length}/${checks.length} checks`,
    checks.length > 0 && checks.every((c) => c.ok),
  );

  // 13 — approval expiry ----------------------------------------------------
  clock.advanceMinutes(1);
  const expiring = b.createTask(owner, 'sim', {
    title: 'ask and vanish',
    kind: 'cli',
    risk: 'spend',
    check: { kind: 'artifact', target: 'receipt.pdf' },
  });
  b.assign(owner, expiring.id, { version: expiring.version, agent: agents['a1']! });
  const expiringTask = b.claim(actorOf('a1'), expiring.id, { version: 2, lease_minutes: 10 });
  void expiringTask;
  readAll('a1');
  const pendingGate = b.gateCheck(actorOf('a1'), {
    task: expiring.id,
    action_hash: sha256('npm publish'),
    command: 'npm publish',
    risk: 'spend',
  });
  clock.advanceHours(25);
  b.keeper();
  const expiredTask = b.requireTask(expiring.id);
  const expiredApproval =
    pendingGate.status === 428 ? b.approvalById(pendingGate.approval_id).status : 'missing';
  observe(
    'approval left pending for 25h',
    `approval=${expiredApproval} task=${expiredTask.status} reason=${expiredTask.resume_note_md ?? 'approval_expired'}`,
    expiredApproval === 'expired' && expiredTask.status === 'blocked',
  );

  // 14 — who counts as the keeper ------------------------------------------
  const keeperEvents = b.store.one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE actor_agent = ?`,
    KEEPER_ACTOR,
  )!.n;
  observe('keeper decisions are in the event log', `${keeperEvents} keeper event(s)`, keeperEvents > 0);

  b.close();
  return rows;
}

async function main(): Promise<void> {
  const rows = await runSimulation();
  const checks = await runRunnerConformance(() => new MemoryRunnerAdapter());
  assertRunnerConformance(checks);

  console.log('# ballroom — Phase 0 / Phase 1 simulation');
  console.log('');
  console.log(`run at ${new Date().toISOString()} (fake clock starts 2026-11-24T09:00:00Z)`);
  console.log('');
  console.log('| # | question | observed | result |');
  console.log('|---|---|---|---|');
  rows.forEach((row, index) => {
    console.log(`| ${index + 1} | ${row.question} | ${row.observed} | ${row.ok ? 'PASS' : 'FAIL'} |`);
  });
  console.log('');
  console.log('## Runner adapter conformance (memory reference implementation)');
  for (const check of checks) console.log(`- ${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
  const failed = rows.filter((row) => !row.ok).length;
  console.log('');
  console.log(`${rows.length - failed}/${rows.length} observations passed.`);
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
