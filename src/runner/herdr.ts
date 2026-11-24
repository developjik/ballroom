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

const run = promisify(execFile);

export type Exec = (argv: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: Exec = async (argv) => {
  const [file, ...args] = argv;
  if (!file) throw new Error('empty command');
  const { stdout, stderr } = await run(file, args, { maxBuffer: 4 * 1024 * 1024 });
  return { stdout, stderr };
};

/**
 * herdr adapter (command mapping only).
 *
 * herdr is a local session driver with `herdr agent start|prompt|wait|read`.
 * Phase 1 ships the mapping and the argv builder; the subcommands marked
 * UNVERIFIED are the ones to confirm against the installed binary before
 * Phase 2 turns this on (docs/SPEC.md §13).
 *
 * The room never talks to herdr directly: this adapter is instantiated by the
 * runner process, which owns the room key.
 */
export class HerdrRunnerAdapter implements RunnerAdapter {
  readonly name = 'herdr';
  private readonly exec: Exec;
  private readonly sessionPrefix: string;

  constructor(options: { exec?: Exec; sessionPrefix?: string } = {}) {
    this.exec = options.exec ?? defaultExec;
    this.sessionPrefix = options.sessionPrefix ?? 'ballroom';
  }

  sessionName(input: { agent: string; task: string }): string {
    return `${this.sessionPrefix}-${input.agent}-${input.task}`;
  }

  startArgs(input: StartInput): string[] {
    return [
      'herdr',
      'agent',
      'start',
      '--name',
      this.sessionName(input),
      '--prompt',
      input.prompt,
      ...(input.cwd ? ['--cwd', input.cwd] : []),
    ];
  }

  resumeArgs(session: RunnerSession, note: string): string[] {
    return ['herdr', 'agent', 'prompt', '--name', session.id, note];
  }

  stopArgs(session: RunnerSession): string[] {
    return ['herdr', 'agent', 'stop', '--name', session.id];
  }

  /** UNVERIFIED: `read --json` is the only read path in the herdr CLI. */
  statusArgs(session: RunnerSession): string[] {
    return ['herdr', 'agent', 'read', '--name', session.id, '--json'];
  }

  usageArgs(session: RunnerSession): string[] {
    return ['herdr', 'agent', 'read', '--name', session.id, '--usage', '--json'];
  }

  /** UNVERIFIED: hook installation for non-interactive runs (Phase 2). */
  installGateArgs(session: RunnerSession, gate: GateInstall): string[] {
    return [
      'herdr',
      'agent',
      'hook',
      'install',
      '--name',
      session.id,
      '--event',
      'pre_tool_use',
      '--config',
      JSON.stringify(gate),
    ];
  }

  async start(input: StartInput): Promise<RunnerSession> {
    await this.exec(this.startArgs(input));
    return { id: this.sessionName(input), agent: input.agent, task: input.task };
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
      const parsed = JSON.parse(stdout) as { status?: RunnerStatus };
      if (parsed.status === 'running' || parsed.status === 'idle' || parsed.status === 'exited') {
        return parsed.status;
      }
    } catch {
      // A missing status field is not an exit: herdr keeps the session alive.
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
