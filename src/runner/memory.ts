import type {
  GateInstall,
  RunnerAdapter,
  RunnerSession,
  RunnerStatus,
  RunnerUsage,
  StartInput,
} from './adapter.js';

interface MemorySession extends RunnerSession {
  status: RunnerStatus;
  notes: string[];
  gates: GateInstall[];
  usage: RunnerUsage;
}

/**
 * Reference adapter. It runs no process: it exists so the runner contract,
 * the conformance suite and the Phase 0 simulation have something honest to
 * drive, and so adapter authors have a small implementation to read first.
 */
export class MemoryRunnerAdapter implements RunnerAdapter {
  readonly name = 'memory';
  private readonly sessions = new Map<string, MemorySession>();
  private counter = 0;
  /** Simulated per-turn token cost. */
  private readonly tokensPerTurn: number;

  constructor(options: { tokensPerTurn?: number } = {}) {
    this.tokensPerTurn = options.tokensPerTurn ?? 1200;
  }

  async start(input: StartInput): Promise<RunnerSession> {
    this.counter += 1;
    const session: MemorySession = {
      id: `mem-${this.counter}`,
      agent: input.agent,
      task: input.task,
      status: 'running',
      notes: [],
      gates: [],
      usage: { turns: 0, tokens_in: 0, tokens_out: 0 },
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async resume(session: RunnerSession, resumeNote: string): Promise<void> {
    const target = this.require(session);
    if (target.status === 'exited') throw new Error(`session ${target.id} has exited`);
    target.notes.push(resumeNote);
    target.status = 'running';
    target.usage.turns += 1;
    target.usage.tokens_in += this.tokensPerTurn;
    target.usage.tokens_out += Math.round(this.tokensPerTurn / 4);
  }

  async stop(session: RunnerSession): Promise<void> {
    const target = this.require(session);
    target.status = 'exited';
  }

  async status(session: RunnerSession): Promise<RunnerStatus> {
    return this.require(session).status;
  }

  async usage(session: RunnerSession): Promise<RunnerUsage> {
    return { ...this.require(session).usage };
  }

  async installGate(session: RunnerSession, gate: GateInstall): Promise<void> {
    const target = this.require(session);
    if (!target.gates.some((existing) => existing.task === gate.task && existing.roomUrl === gate.roomUrl)) {
      target.gates.push({ ...gate });
    }
  }

  /** Test hook: what the adapter saw. */
  inspect(session: RunnerSession): { notes: string[]; gates: GateInstall[] } {
    const target = this.require(session);
    return { notes: [...target.notes], gates: target.gates.map((gate) => ({ ...gate })) };
  }

  private require(session: RunnerSession): MemorySession {
    const target = this.sessions.get(session.id);
    if (!target) throw new Error(`unknown session ${session.id}`);
    return target;
  }
}
