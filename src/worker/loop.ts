/**
 * The worker loop — what turns a room from a queue into work that gets done.
 *
 *   GET /v1/inbox?wait=30   wait until something is mine
 *   POST /tasks/:id/claim   take it (version CAS; one winner)
 *   installGate + runner.start(prompt)
 *   POST /tasks/:id/renew   heartbeat while the runner works
 *   (hook 428)              the task becomes awaiting_approval
 *        wait for the owner's decision → claim again → runner.resume(note)
 *        → read the room (confirm guard) → retry
 *   POST /usage             report the runner's turns and tokens
 *   POST /tasks/:id/artifacts  upload what the turn produced
 *   POST /tasks/:id/complete   status review, with proof
 *
 * Two guards matter more than the rest, because both were the reason the gate
 * looked broken in Phase 1:
 *
 *   1. Before every gate call the worker reads the room up to `task.last_seq`.
 *      The hook's confirm guard compares `agent.last_delivered_seq` with the
 *      task, so a worker that forgets to read turns every risky action into
 *      `409 unread_events`.
 *   2. An approval decision mutates the task (grant + status), which advances
 *      `last_seq` again — so the worker reads once more after the decision,
 *      before it resumes the runner.
 *
 * The worker ends at `review`, not `done`: verification belongs to the owner or
 * a different agent (`SPEC §8.1`), and the assignee may not verify itself.
 */
import { ApiError } from '../errors.js';
import type { Task, TaskStatus } from '../types.js';
import type { ArtifactSource } from '../runner/cli.js';
import type { RunnerAdapter, RunnerSession } from '../runner/adapter.js';
import { RoomApi } from './api.js';

export type WorkerResult = 'completed' | 'blocked' | 'released' | 'skipped' | 'failed';

export interface WorkerOutcome {
  task: string;
  result: WorkerResult;
  detail: string;
  status?: TaskStatus;
  session?: string;
  artifacts?: string[];
  turns?: number;
}

export interface WorkerOptions {
  baseUrl: string;
  token: string;
  runner: RunnerAdapter;
  /** Agent id, for the prompt and the log line. */
  agent?: string;
  room?: string;
  cwd?: string;
  leaseMinutes?: number;
  /** Long-poll length for the inbox. Default 30s. */
  waitSeconds?: number;
  /** Heartbeat interval. Default half the lease. */
  renewEveryMs?: number;
  /** Runner status poll interval. Default 200ms. */
  pollMs?: number;
  /** How long one turn may run without an answer. Default 10 min. */
  turnTimeoutMs?: number;
  /** How long to wait for the owner to decide an approval. Default 20 min. */
  approvalTimeoutMs?: number;
  /** Also claim tasks that are `open` (no assignment yet). Default false. */
  claimOpen?: boolean;
  /** Install the pre-tool hook for each task. Default true. */
  installGate?: boolean;
  prompt?: (task: Task, extra: { resumeNote: string | null; agent: string | null }) => string;
  log?: (line: string) => void;
  /** Injection point for tests. */
  api?: RoomApi;
}

export class Worker {
  readonly api: RoomApi;
  private readonly options: WorkerOptions;
  private readonly handled = new Set<string>();
  private readonly reported = new Map<string, { turns: number; tokensIn: number; tokensOut: number }>();
  cursor = 0;

  constructor(options: WorkerOptions) {
    this.options = options;
    this.api = options.api ?? new RoomApi(options.baseUrl, options.token);
  }

  private log(line: string): void {
    (this.options.log ?? ((text: string) => console.log(text)))(line);
  }

  /** One long-poll, then run whatever it handed us. */
  async pollOnce(): Promise<{ cursor: number; outcomes: WorkerOutcome[] }> {
    const page = await this.api.inbox(this.cursor, this.options.waitSeconds ?? 30);
    this.cursor = page.cursor;
    const taskIds: string[] = [];
    for (const item of page.items) {
      if (!item.task_id || taskIds.includes(item.task_id)) continue;
      taskIds.push(item.task_id);
    }
    const outcomes: WorkerOutcome[] = [];
    for (const taskId of taskIds) {
      if (this.handled.has(taskId)) continue;
      this.handled.add(taskId);
      try {
        outcomes.push(await this.runTask(taskId));
      } finally {
        this.handled.delete(taskId);
      }
    }
    return { cursor: page.cursor, outcomes };
  }

  /** Poll → work → poll, until the abort signal fires. */
  async loop(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (signal?.aborted) return;
        this.log(`worker: poll failed: ${describe(error)}`);
        await sleep(this.options.pollMs ?? 200);
      }
    }
  }

  async runTask(taskId: string): Promise<WorkerOutcome> {
    const agent = this.options.agent ?? null;
    let task: Task;
    try {
      task = await this.api.task(taskId);
    } catch (error) {
      return { task: taskId, result: 'skipped', detail: `could not read the task: ${describe(error)}` };
    }

    if (task.status === 'running') {
      return { task: task.id, result: 'skipped', detail: 'already running', status: task.status };
    }
    if (task.status === 'assigned' && task.assignee && agent && task.assignee !== agent) {
      return { task: task.id, result: 'skipped', detail: `assigned to ${task.assignee}`, status: task.status };
    }
    if (task.status === 'open' && !this.options.claimOpen) {
      return { task: task.id, result: 'skipped', detail: 'open, not assigned to me', status: task.status };
    }
    if (!['open', 'assigned'].includes(task.status)) {
      return { task: task.id, result: 'skipped', detail: `status ${task.status}`, status: task.status };
    }

    const leaseMinutes = this.options.leaseMinutes ?? 5;
    try {
      task = await this.api.claim(task.id, task.version, leaseMinutes);
    } catch (error) {
      return { task: task.id, result: 'skipped', detail: `claim refused: ${describe(error)}`, status: task.status };
    }
    this.log(`worker: claimed ${task.id} "${task.title}" (risk ${task.risk})`);

    // The hook's confirm guard looks at what the room has delivered, so read up
    // to the task's last event before the runner can send a tool call.
    await this.catchUp(task.last_seq);

    let session: RunnerSession;
    const prompt = (this.options.prompt ?? defaultPrompt)(task, { resumeNote: null, agent });
    try {
      session = await this.options.runner.start({
        agent: agent ?? task.assignee ?? 'worker',
        task: task.id,
        prompt,
        ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      });
    } catch (error) {
      const blocked = await this.safeBlock(task, `runner failed to start: ${describe(error)}`);
      return { task: task.id, result: 'blocked', detail: `runner failed to start: ${describe(error)}`, status: blocked?.status };
    }

    if (this.options.installGate !== false) {
      try {
        await this.options.runner.installGate(session, {
          roomUrl: this.api.baseUrl,
          task: task.id,
          token: this.options.token,
        });
      } catch (error) {
        this.log(`worker: installGate failed for ${task.id}: ${describe(error)}`);
      }
    }

    const heartbeat = this.startHeartbeat(task.id, leaseMinutes);
    try {
      return await this.drive(task, session);
    } catch (error) {
      const message = describe(error);
      const blocked = await this.safeBlock(task, message);
      return { task: task.id, result: 'blocked', detail: message, ...(blocked ? { status: blocked.status } : {}), session: session.id };
    } finally {
      clearInterval(heartbeat);
      try {
        await this.options.runner.stop(session);
      } catch {
        // The session is already gone; nothing to clean up.
      }
      this.reported.delete(session.id);
    }
  }

  // ------------------------------------------------------------- the turn

  private async drive(task: Task, session: RunnerSession): Promise<WorkerOutcome> {
    const artifacts: string[] = [];
    let turns = 0;
    let current = task;

    for (let round = 0; round < 4; round += 1) {
      const status = await this.waitForTurnEnd(session);
      turns += (await this.reportUsage(task.id, session)) ?? 0;

      const uploaded = await this.uploadArtifacts(task.id, session);
      artifacts.push(...uploaded);

      await this.catchUp(null);
      current = await this.api.task(task.id);

      if (status === 'exited') {
        const blocked = await this.safeBlock(current, 'runner exited before the turn finished');
        return {
          task: task.id,
          result: 'blocked',
          detail: 'runner exited before the turn finished',
          ...(blocked ? { status: blocked.status } : {}),
          session: session.id,
          artifacts,
          turns,
        };
      }

      // The room hands the task back after an approval: either we saw
      // `awaiting_approval` and waited here, or the owner answered before this
      // loop looked again and the task is already `assigned` again.
      let decidedTask: Task | null = null;
      if (current.status === 'awaiting_approval') {
        this.log(`worker: ${task.id} is waiting for the owner's approval`);
        decidedTask = await this.waitForApproval(task.id);
        if (!decidedTask) {
          return {
            task: task.id,
            result: 'failed',
            detail: 'no approval decision in time',
            session: session.id,
            artifacts,
            turns,
          };
        }
      } else if (current.status === 'assigned' && (!this.options.agent || current.assignee === this.options.agent)) {
        decidedTask = current;
      }

      if (decidedTask) {
        if (decidedTask.status !== 'assigned') {
          const detail = `task is ${decidedTask.status} after the approval decision`;
          this.log(`worker: ${task.id} ${detail}`);
          return {
            task: task.id,
            result: decidedTask.status === 'blocked' ? 'blocked' : 'failed',
            detail,
            status: decidedTask.status,
            session: session.id,
            artifacts,
            turns,
          };
        }
        // The decision wrote a grant and advanced the task's last_seq; read it
        // before the model retries, or the hook answers 409 unread_events.
        await this.catchUp(decidedTask.last_seq);
        const reclaimed = await this.api.claim(task.id, decidedTask.version, this.options.leaseMinutes ?? 5);
        // claim appends `task.claimed`, which advances last_seq again — read once
        // more, or the very next hook call answers 409 unread_events.
        await this.catchUp(reclaimed.last_seq);
        const note = decidedTask.resume_note_md ?? 'Approval granted; retry the blocked command once.';
        this.log(`worker: resuming ${task.id} after approval — ${note}`);
        await this.options.runner.resume(session, note);
        continue;
      }

      if (current.status === 'running') {
        await this.catchUp(current.last_seq);
        const fresh = await this.api.task(task.id);
        const proof = {
          runner: this.options.runner.name,
          session: session.id,
          backend_ref: session.backendRef ?? null,
          artifacts,
          turns,
          finished_at: new Date().toISOString(),
        };
        const completed = await this.api.complete(task.id, {
          version: fresh.version,
          read_seq: Math.max(this.cursor, fresh.last_seq),
          proof,
        });
        this.log(`worker: completed ${task.id} → ${completed.status}`);
        return {
          task: task.id,
          result: 'completed',
          detail: `completed as ${completed.status}`,
          status: completed.status,
          session: session.id,
          artifacts,
          turns,
        };
      }

      return {
        task: task.id,
        result: current.status === 'blocked' ? 'blocked' : 'failed',
        detail: `task is ${current.status}`,
        status: current.status,
        session: session.id,
        artifacts,
        turns,
      };
    }

    const blocked = await this.safeBlock(current, 'too many approval rounds');
    return {
      task: task.id,
      result: 'blocked',
      detail: 'too many approval rounds',
      ...(blocked ? { status: blocked.status } : {}),
      session: session.id,
      artifacts,
      turns,
    };
  }

  private async waitForTurnEnd(session: RunnerSession): Promise<'running' | 'idle' | 'exited'> {
    const deadline = Date.now() + (this.options.turnTimeoutMs ?? 10 * 60_000);
    const pollMs = this.options.pollMs ?? 200;
    while (Date.now() < deadline) {
      const status = await this.options.runner.status(session);
      if (status !== 'running') return status;
      await sleep(pollMs);
    }
    return 'running';
  }

  private async waitForApproval(taskId: string): Promise<Task | null> {
    const deadline = Date.now() + (this.options.approvalTimeoutMs ?? 20 * 60_000);
    const pollMs = Math.max(50, this.options.pollMs ?? 200);
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const task = await this.api.task(taskId);
      if (task.status !== 'awaiting_approval') return task;
    }
    return null;
  }

  // --------------------------------------------------------------- support

  /** Read the room until the given task sequence is delivered. */
  async catchUp(target: number | null): Promise<void> {
    const wanted = target ?? 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (this.cursor >= wanted && attempt > 0) return;
      const page = await this.api.inbox(this.cursor, 0);
      const moved = page.cursor !== this.cursor;
      this.cursor = page.cursor;
      if (!moved) return;
      if (this.cursor >= wanted) return;
    }
  }

  private startHeartbeat(taskId: string, leaseMinutes: number): NodeJS.Timeout {
    const every = this.options.renewEveryMs ?? Math.max(1000, Math.floor((leaseMinutes * 60_000) / 2));
    const timer = setInterval(() => {
      this.api.renew(taskId, leaseMinutes).catch((error: unknown) => {
        this.log(`worker: renew refused for ${taskId}: ${describe(error)}`);
      });
    }, every);
    timer.unref?.();
    return timer;
  }

  /** Report the delta since the last report; the room sums, it does not take absolutes. */
  private async reportUsage(taskId: string, session: RunnerSession): Promise<number | null> {
    let usage;
    try {
      usage = await this.options.runner.usage(session);
    } catch {
      return null;
    }
    const previous = this.reported.get(session.id) ?? { turns: 0, tokensIn: 0, tokensOut: 0 };
    const delta = {
      turns: Math.max(0, usage.turns - previous.turns),
      tokens_in: Math.max(0, usage.tokens_in - previous.tokensIn),
      tokens_out: Math.max(0, usage.tokens_out - previous.tokensOut),
    };
    if (delta.turns === 0 && delta.tokens_in === 0 && delta.tokens_out === 0) return 0;
    this.reported.set(session.id, { turns: usage.turns, tokensIn: usage.tokens_in, tokensOut: usage.tokens_out });
    try {
      await this.api.reportUsage({ task: taskId, ...delta });
      return delta.turns;
    } catch (error) {
      this.log(`worker: usage report refused for ${taskId}: ${describe(error)}`);
      return delta.turns;
    }
  }

  private async uploadArtifacts(taskId: string, session: RunnerSession): Promise<string[]> {
    const source = this.options.runner as Partial<ArtifactSource>;
    if (typeof source.collectArtifacts !== 'function') return [];
    let collected;
    try {
      collected = await source.collectArtifacts(session);
    } catch (error) {
      this.log(`worker: could not collect artifacts for ${taskId}: ${describe(error)}`);
      return [];
    }
    const uploaded: string[] = [];
    for (const artifact of collected) {
      try {
        const answer = await this.api.putArtifact(taskId, artifact);
        uploaded.push(answer.artifact.id);
        this.log(`worker: artifact ${artifact.name} → ${answer.artifact.id} (${answer.artifact.bytes} bytes)`);
      } catch (error) {
        this.log(`worker: artifact ${artifact.name} refused: ${describe(error)}`);
      }
    }
    return uploaded;
  }

  private async safeBlock(task: Task, reason: string): Promise<Task | null> {
    try {
      const fresh = await this.api.task(task.id);
      if (!['assigned', 'running', 'waiting', 'awaiting_approval', 'review'].includes(fresh.status)) return fresh;
      return await this.api.block(task.id, { version: fresh.version, reason });
    } catch (error) {
      this.log(`worker: could not block ${task.id}: ${describe(error)}`);
      return null;
    }
  }
}

export function defaultPrompt(task: Task, extra: { resumeNote: string | null; agent: string | null }): string {
  const lines = [
    `You are ${extra.agent ?? 'the assignee'} in a ballroom room, working task ${task.id}.`,
    ``,
    `Title: ${task.title}`,
    `Risk: ${task.risk} · check: ${task.check.kind}${task.check.target ? ` (${task.check.target})` : ''}`,
    `Budgets: ${task.budget_turns} turn(s)${task.budget_tokens ? `, ${task.budget_tokens} tokens` : ''}`,
  ];
  if (task.body_md.trim() !== '') {
    lines.push('', 'Body:', task.body_md.trim());
  }
  if (extra.resumeNote) {
    lines.push('', `Resume note from the room: ${extra.resumeNote}`);
  }
  lines.push(
    '',
    'A pre-tool hook blocks irreversible, spend and outbound actions until the owner',
    'approves them once. If a command is blocked, stop the turn and report the',
    'approval id from the error instead of retrying it.',
    'Finish by writing what you produced to a file; the runner uploads it as the proof.',
  );
  return lines.join('\n');
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.status} ${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
