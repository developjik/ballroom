import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  GateInstall,
  RunnerAdapter,
  RunnerSession,
  RunnerStatus,
  RunnerUsage,
  StartInput,
} from './adapter.js';
import type { Exec } from './herdr.js';

const run = promisify(execFile);

const defaultExec: Exec = async (argv) => {
  const [file, ...args] = argv;
  if (!file) throw new Error('empty command');
  const { stdout, stderr } = await run(file, args, { maxBuffer: 4 * 1024 * 1024 });
  return { stdout, stderr };
};

/**
 * damon-agent-core adapter (command mapping only).
 *
 * Damon is a local Rust daemon that drives nine agent CLIs over their native
 * protocols (`session.create`, `session.resume`, `turn.start`, permission
 * relay). It is the natural host for the runner role: it already owns
 * sessions, permission asks and usage — which is exactly the six calls below.
 *
 * Phase 1 ships the mapping; a real wiring needs Damon's RPC (its CLI is a thin
 * client over the same daemon). The argv below is the CLI shape from the
 * project README and is UNVERIFIED against a running daemon.
 */
export class DamonRunnerAdapter implements RunnerAdapter {
  readonly name = 'damon';
  private readonly exec: Exec;
  private readonly project: string;

  constructor(options: { exec?: Exec; project?: string } = {}) {
    this.exec = options.exec ?? defaultExec;
    this.project = options.project ?? '.';
  }

  startArgs(input: StartInput): string[] {
    return [
      'damon',
      'session',
      'create',
      '--project',
      input.cwd ?? this.project,
      '--agent',
      input.agent,
      '--title',
      `ballroom ${input.task}`,
      '--prompt',
      input.prompt,
    ];
  }

  resumeArgs(session: RunnerSession, note: string): string[] {
    return ['damon', 'session', 'resume', session.id, '--prompt', note];
  }

  stopArgs(session: RunnerSession): string[] {
    return ['damon', 'session', 'stop', session.id];
  }

  statusArgs(session: RunnerSession): string[] {
    return ['damon', 'session', 'show', session.id, '--json'];
  }

  usageArgs(session: RunnerSession): string[] {
    return ['damon', 'session', 'usage', session.id, '--json'];
  }

  /** Damon already relays permission asks; the room's gate is the second guard. */
  installGateArgs(session: RunnerSession, gate: GateInstall): string[] {
    return [
      'damon',
      'permission',
      'relay',
      '--session',
      session.id,
      '--room',
      gate.roomUrl,
      '--task',
      gate.task,
    ];
  }

  async start(input: StartInput): Promise<RunnerSession> {
    const { stdout } = await this.exec(this.startArgs(input));
    let id = '';
    try {
      id = (JSON.parse(stdout) as { session_id?: string }).session_id ?? '';
    } catch {
      id = stdout.trim().split(/\s+/).pop() ?? '';
    }
    if (!id) throw new Error('damon did not return a session id');
    return { id, agent: input.agent, task: input.task };
  }

  async resume(session: RunnerSession, resumeNote: string): Promise<void> {
    await this.exec(this.resumeArgs(session, resumeNote));
  }

  async stop(session: RunnerSession): Promise<void> {
    await this.exec(this.stopArgs(session));
  }

  async status(session: RunnerSession): Promise<RunnerStatus> {
    try {
      const { stdout } = await this.exec(this.statusArgs(session));
      const parsed = JSON.parse(stdout) as { status?: string };
      if (parsed.status === 'running' || parsed.status === 'idle' || parsed.status === 'exited') {
        return parsed.status;
      }
    } catch {
      // Unknown output is treated as alive; the room's lease is the real guard.
    }
    return 'running';
  }

  async usage(session: RunnerSession): Promise<RunnerUsage> {
    const { stdout } = await this.exec(this.usageArgs(session));
    const parsed = JSON.parse(stdout) as Partial<RunnerUsage>;
    return {
      turns: Number(parsed.turns ?? 0),
      tokens_in: Number(parsed.tokens_in ?? 0),
      tokens_out: Number(parsed.tokens_out ?? 0),
    };
  }

  async installGate(session: RunnerSession, gate: GateInstall): Promise<void> {
    await this.exec(this.installGateArgs(session, gate));
  }
}
