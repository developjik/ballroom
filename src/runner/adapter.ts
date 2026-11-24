/**
 * RunnerAdapter — the seam between the room and whatever drives the agent.
 *
 * Phase 1 ships the contract and a reference implementation; `herdr` and
 * `damon-agent-core` implement the same six calls (docs/SPEC.md §13). The room
 * never imports a runner: it hands a task to an adapter and gets sessions back.
 *
 *   start(agent, task, prompt) → session
 *   resume(session, resume_note)
 *   stop(session)
 *   status(session) → running | idle | exited
 *   usage(session) → {turns, tokens_in, tokens_out}
 *   install_gate(session, {room_url, task, token})
 *
 * The gate is what makes a CLI agent's risky action block *before* it happens:
 * the runner installs a pre-tool hook that POSTs /v1/gate/check and refuses the
 * call on 428. A hosted assistant has no such hook — the room records
 * `approval.delegated` instead (SPEC §6.3).
 */

export interface RunnerSession {
  /** Adapter-local id (pid, socket, tmux name…). */
  id: string;
  agent: string;
  task: string;
  /** Backend handle the adapter needs to resume (session key, socket path…). */
  backendRef?: string;
}

export interface RunnerUsage {
  turns: number;
  tokens_in: number;
  tokens_out: number;
}

export type RunnerStatus = 'running' | 'idle' | 'exited';

export interface StartInput {
  agent: string;
  task: string;
  prompt: string;
  /** Worktree / cwd the agent should run in. */
  cwd?: string;
}

export interface GateInstall {
  roomUrl: string;
  task: string;
  /** Agent key the hook uses to call /v1/gate/check. */
  token: string;
}

export interface RunnerAdapter {
  readonly name: string;
  start(input: StartInput): Promise<RunnerSession>;
  resume(session: RunnerSession, resumeNote: string): Promise<void>;
  stop(session: RunnerSession): Promise<void>;
  status(session: RunnerSession): Promise<RunnerStatus>;
  usage(session: RunnerSession): Promise<RunnerUsage>;
  installGate(session: RunnerSession, gate: GateInstall): Promise<void>;
}

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * A runner is conformant when the room can drive it without knowing which one
 * it is. Adapter authors run this before wiring a room to their runner:
 *
 *   const checks = await runRunnerConformance(() => new MyAdapter());
 *   assertRunnerConformance(checks);
 */
export async function runRunnerConformance(create: () => RunnerAdapter): Promise<ConformanceCheck[]> {
  const checks: ConformanceCheck[] = [];
  const record = (name: string, ok: boolean, detail?: string) =>
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail });

  let adapter: RunnerAdapter;
  try {
    adapter = create();
    record('adapter constructs and has a name', typeof adapter.name === 'string' && adapter.name.length > 0);
  } catch (error) {
    record('adapter constructs and has a name', false, String(error));
    return checks;
  }

  let first: RunnerSession | undefined;
  try {
    first = await adapter.start({ agent: 'conformance-agent', task: 'task-1', prompt: 'do the thing' });
    record('start returns a session', !!first?.id, `id=${first?.id ?? 'none'}`);
    record('start records agent and task', first?.agent === 'conformance-agent' && first?.task === 'task-1');
    record('a started session is running', (await adapter.status(first)) === 'running');
  } catch (error) {
    record('start returns a session', false, String(error));
    return checks;
  }

  try {
    await adapter.resume(first, 'Approval granted: run the test suite');
    record('resume accepts a resume note', (await adapter.status(first)) === 'running');
  } catch (error) {
    record('resume accepts a resume note', false, String(error));
  }

  try {
    const usage = await adapter.usage(first);
    record(
      'usage reports non-negative integers',
      Number.isInteger(usage.turns) &&
        Number.isInteger(usage.tokens_in) &&
        Number.isInteger(usage.tokens_out) &&
        usage.turns >= 0 &&
        usage.tokens_in >= 0 &&
        usage.tokens_out >= 0,
      JSON.stringify(usage),
    );
  } catch (error) {
    record('usage reports non-negative integers', false, String(error));
  }

  try {
    const gate: GateInstall = { roomUrl: 'https://room.example', task: first.task, token: 'br_test' };
    await adapter.installGate(first, gate);
    await adapter.installGate(first, gate);
    record('installGate is idempotent', true);
  } catch (error) {
    record('installGate is idempotent', false, String(error));
  }

  try {
    const second = await adapter.start({ agent: 'conformance-agent', task: 'task-2', prompt: 'another' });
    record('sessions are distinct', second.id !== first.id, `${first.id} vs ${second.id}`);
    await adapter.stop(second);
    record('stop moves a session to exited', (await adapter.status(second)) === 'exited');
    await adapter.stop(second);
    record('stop is idempotent', (await adapter.status(second)) === 'exited');
  } catch (error) {
    record('sessions are distinct', false, String(error));
  }

  try {
    await adapter.stop(first);
    record('the first session can be stopped too', (await adapter.status(first)) === 'exited');
  } catch (error) {
    record('the first session can be stopped too', false, String(error));
  }

  return checks;
}

export function assertRunnerConformance(checks: ConformanceCheck[]): void {
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    const lines = failed.map((check) => `- ${check.name}${check.detail ? `: ${check.detail}` : ''}`);
    throw new Error(`Runner is not conformant:\n${lines.join('\n')}`);
  }
}
