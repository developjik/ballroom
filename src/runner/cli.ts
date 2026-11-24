/**
 * CliRunnerAdapter — drives a real agent CLI (`claude`, `codex`, `damon`,
 * anything with a prompt-in / turn-out interface) as a child process.
 *
 * It implements the same six calls the room knows (adapter.ts):
 *
 *   start   spawn the CLI in the task's cwd with the prompt
 *   resume  steer a running turn (stdin) or spawn a resume of a finished one
 *   stop    SIGTERM → grace → SIGKILL, and mark the session exited
 *   status  running while the child lives, idle after a clean turn, exited after
 *           a stop or a non-zero exit
 *   usage   from a usage command (`claude`/`damon` both expose one), else the
 *           turn count this adapter observed
 *   installGate  write the pre-tool hook into the project and the per-session
 *                gate file the hook reads (`.ballroom/gate.json`)
 *
 * The prompt is an argv token, not a shell string, so nothing the task says can
 * turn into a shell injection.
 *
 * What is verified in this repository: the process lifecycle, status, stop,
 * resume-over-stdin, usage parsing and gate installation, driven by
 * `tests/fixtures/mock-agent.mjs` and `runRunnerConformance`.
 * What is NOT verified here: the argv of a specific vendor CLI against a real
 * installation. The defaults below follow the documented flags of Claude Code
 * (`claude -p`, `--resume`, `--output-format json`); check them against your
 * installed version before trusting them, or pass your own `command`.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { hookCommand, installGate as installProjectGate, type GateFile } from '../hook/install.js';
import type {
  GateInstall,
  RunnerAdapter,
  RunnerSession,
  RunnerStatus,
  RunnerUsage,
  StartInput,
} from './adapter.js';

const run = promisify(execFile);

export interface CliArtifact {
  name: string;
  content: Buffer;
  mime: string;
  summary: string;
}

/** Adapters that can hand their outputs to the room implement this. */
export interface ArtifactSource {
  collectArtifacts(session: RunnerSession): Promise<CliArtifact[]>;
}

export interface CliRunnerOptions {
  name?: string;
  /** argv template. Placeholders: {prompt} {note} {task} {agent} {session} {cwd} */
  command?: string[];
  resumeCommand?: string[];
  usageCommand?: string[];
  usageParser?: (raw: string, session: RunnerSession) => RunnerUsage;
  cwd?: string;
  env?: Record<string, string>;
  /** Files (relative to cwd, or absolute) uploaded when a turn ends. */
  outputs?: string[];
  /** Upload the run log as an artifact. Default true. */
  captureLog?: boolean;
  maxLogBytes?: number;
  killGraceMs?: number;
  /** Write the pre-tool hook into the project on installGate. Default true. */
  installHook?: boolean;
  /** Finds a vendor session id in the CLI's first output (e.g. claude JSON). */
  sessionIdPattern?: RegExp;
  /** Custom session discovery (damon: poll `damon sessions --json`). */
  discoverSession?: (session: RunnerSession, io: DiscoveryContext) => Promise<string | undefined>;
  /** Written to the child's stdin before SIGTERM (damon: `/cancel`). */
  cancelText?: string;
  /** How long to give `cancelText` to take effect. Default 300ms. */
  cancelGraceMs?: number;
}

export interface DiscoveryContext {
  session: RunnerSession;
  cwd: string;
  startedAt: number;
  exec: (argv: string[]) => Promise<string>;
}

interface SessionState {
  session: RunnerSession;
  child: ChildProcess | null;
  status: RunnerStatus;
  stopped: boolean;
  exitCode: number | null;
  log: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  gate: GateInstall | null;
  cwd: string;
  runs: number;
  startedAt: number;
  stopPromise: Promise<void> | null;
}

const DEFAULT_COMMAND = ['claude', '-p', '{prompt}'];
const DEFAULT_RESUME = ['claude', '-p', '--resume', '{session}', '{note}'];

export class CliRunnerAdapter implements RunnerAdapter, ArtifactSource {
  readonly name: string;
  private readonly options: CliRunnerOptions;
  private readonly sessions = new Map<string, SessionState>();
  private counter = 0;

  constructor(options: CliRunnerOptions = {}) {
    this.options = options;
    this.name = options.name ?? 'cli';
  }

  // ------------------------------------------------------------- lifecycle

  async start(input: StartInput): Promise<RunnerSession> {
    this.counter += 1;
    const cwd = input.cwd ?? this.options.cwd ?? process.cwd();
    const session: RunnerSession = {
      id: `cli-${this.counter}`,
      agent: input.agent,
      task: input.task,
    };
    const state: SessionState = {
      session,
      child: null,
      status: 'running',
      stopped: false,
      exitCode: null,
      log: '',
      turns: 0,
      tokensIn: 0,
      tokensOut: 0,
      gate: null,
      cwd,
      runs: 0,
      startedAt: Date.now(),
      stopPromise: null,
    };
    this.sessions.set(session.id, state);
    await this.spawnTurn(state, this.options.command ?? DEFAULT_COMMAND, {
      prompt: input.prompt,
      note: '',
      task: input.task,
      agent: input.agent,
      session: session.id,
      cwd,
    });
    return session;
  }

  async resume(session: RunnerSession, resumeNote: string): Promise<void> {
    const state = this.require(session);
    if (state.stopped) throw new Error(`session ${session.id} has been stopped`);
    if (state.child && state.child.exitCode === null && state.child.stdin?.writable) {
      // A live turn is steered, not restarted — this is how a runner hands an
      // approval back to a model that is still in its loop.
      state.child.stdin.write(`${resumeNote.replace(/\r?\n/g, ' ')}\n`);
      state.status = 'running';
      return;
    }
    const template = this.options.resumeCommand ?? DEFAULT_RESUME;
    state.status = 'running';
    await this.spawnTurn(state, template, {
      prompt: resumeNote,
      note: resumeNote,
      task: session.task,
      agent: session.agent,
      session: session.backendRef ?? session.id,
      cwd: state.cwd,
    });
  }

  async stop(session: RunnerSession): Promise<void> {
    const state = this.require(session);
    if (state.stopPromise) return state.stopPromise;
    state.stopped = true;
    state.stopPromise = this.terminate(state).then(() => {
      state.status = 'exited';
    });
    await state.stopPromise;
  }

  async status(session: RunnerSession): Promise<RunnerStatus> {
    const state = this.require(session);
    return state.status;
  }

  async usage(session: RunnerSession): Promise<RunnerUsage> {
    const state = this.require(session);
    const command = this.options.usageCommand;
    if (command) {
      const target = session.backendRef ?? session.id;
      const argv = this.substitute(command, {
        prompt: '',
        note: '',
        task: session.task,
        agent: session.agent,
        session: target,
        cwd: state.cwd,
      });
      try {
        const { stdout } = await run(argv[0]!, argv.slice(1), { cwd: state.cwd, maxBuffer: 4 * 1024 * 1024 });
        const parsed = this.options.usageParser
          ? this.options.usageParser(stdout, session)
          : parseUsageJson(stdout);
        state.tokensIn = parsed.tokens_in;
        state.tokensOut = parsed.tokens_out;
        if (parsed.turns > 0) state.turns = Math.max(state.turns, parsed.turns);
      } catch {
        // A usage command that fails must not turn a finished task into an
        // error; the turn count below is still true.
      }
    }
    return {
      turns: Math.max(0, Math.trunc(state.turns)),
      tokens_in: Math.max(0, Math.trunc(state.tokensIn)),
      tokens_out: Math.max(0, Math.trunc(state.tokensOut)),
    };
  }

  async installGate(session: RunnerSession, gate: GateInstall): Promise<void> {
    const state = this.require(session);
    state.gate = { ...gate };
    if (this.options.installHook === false) return;
    const gateFile: GateFile = {
      room_url: gate.roomUrl,
      task: gate.task,
      token: gate.token,
      agent: session.agent,
      session: session.id,
    };
    installProjectGate({
      dir: state.cwd,
      command: hookCommand(),
      gate: gateFile,
    });
  }

  async collectArtifacts(session: RunnerSession): Promise<CliArtifact[]> {
    const state = this.require(session);
    const artifacts: CliArtifact[] = [];
    if (this.options.captureLog !== false && state.log.trim() !== '') {
      artifacts.push({
        name: `run-${session.id}.log`,
        content: Buffer.from(state.log, 'utf8'),
        mime: 'text/plain',
        summary: `${session.agent} on ${session.task} · ${state.runs} turn(s) · exit ${state.exitCode ?? 'n/a'}`,
      });
    }
    for (const output of this.options.outputs ?? []) {
      const path = isAbsolute(output) ? output : resolve(state.cwd, output);
      if (!existsSync(path)) continue;
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue;
      artifacts.push({
        name: basename(path),
        content: readFileSync(path),
        mime: guessMime(path),
        summary: `${stat.size} bytes from ${output}`,
      });
    }
    return artifacts;
  }

  /** Test hook: the raw log of a session. */
  inspect(session: RunnerSession): { log: string; runs: number; exitCode: number | null; gate: GateInstall | null } {
    const state = this.require(session);
    return { log: state.log, runs: state.runs, exitCode: state.exitCode, gate: state.gate };
  }

  // -------------------------------------------------------------- internals

  private async spawnTurn(
    state: SessionState,
    template: string[],
    values: { prompt: string; note: string; task: string; agent: string; session: string; cwd: string },
  ): Promise<void> {
    const argv = this.substitute(template, values);
    const [file, ...args] = argv;
    if (!file) throw new Error('the runner command is empty');
    state.runs += 1;
    state.turns += 1;
    state.exitCode = null;
    const child = spawn(file, args, {
      cwd: state.cwd,
      env: {
        ...process.env,
        ...this.options.env,
        BALLROOM_TASK: values.task,
        BALLROOM_AGENT: values.agent,
        ...(state.gate ? { BALLROOM_ROOM_URL: state.gate.roomUrl, BALLROOM_TOKEN: state.gate.token } : {}),
        BALLROOM_SESSION: values.session,
        BALLROOM_HOOK: 'ballroom-gate',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    state.child = child;
    state.status = 'running';

    const append = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const limit = this.options.maxLogBytes ?? 256 * 1024;
      state.log += text;
      if (state.log.length > limit) state.log = `…(truncated)…\n${state.log.slice(state.log.length - limit)}`;
      const pattern = this.options.sessionIdPattern;
      if (pattern && !state.session.backendRef) {
        const match = pattern.exec(text);
        if (match?.[1]) state.session.backendRef = match[1];
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    child.on('error', (error) => {
      state.log += `\n[spawn error] ${error.message}\n`;
      state.status = 'exited';
    });
    child.on('exit', (code, signal) => {
      state.exitCode = code;
      if (state.stopped) {
        state.status = 'exited';
        return;
      }
      // A clean turn leaves the session reusable (idle); a crash does not.
      state.status = code === 0 ? 'idle' : 'exited';
      if (signal) state.log += `\n[signal] ${signal}\n`;
    });

    if (!state.session.backendRef) {
      const discovered = await this.discoverSessionId({
        session: state.session,
        cwd: state.cwd,
        startedAt: state.startedAt,
        exec: async (commandArgv: string[]) => {
          const { stdout } = await run(commandArgv[0]!, commandArgv.slice(1), {
            cwd: state.cwd,
            maxBuffer: 4 * 1024 * 1024,
          });
          return stdout;
        },
      });
      if (discovered) state.session.backendRef = discovered;
    }
  }

  /**
   * A CLI that does not print the id of the session it created needs a lookup;
   * subclasses (damon) override this. Default: the configured callback, else
   * nothing — the local id stays the only handle.
   */
  protected async discoverSessionId(context: DiscoveryContext): Promise<string | undefined> {
    if (!this.options.discoverSession) return undefined;
    return this.options.discoverSession(context.session, context);
  }

  private async terminate(state: SessionState): Promise<void> {
    const child = state.child;
    if (!child || child.exitCode !== null) {
      state.exitCode = child?.exitCode ?? state.exitCode;
      return;
    }
    // Ask the session to stop its turn before the process is signalled: a CLI
    // that owns the turn (damon: `/cancel`) then records a clean cancellation
    // instead of an abrupt disconnect.
    if (this.options.cancelText && child.stdin?.writable) {
      try {
        child.stdin.write(`${this.options.cancelText}\n`);
      } catch {
        // stdin already closed
      }
      await new Promise<void>((resolveGrace) => setTimeout(resolveGrace, this.options.cancelGraceMs ?? 300));
      if (child.exitCode !== null) {
        state.exitCode = child.exitCode;
        return;
      }
    }
    const exited = new Promise<void>((resolveExit) => {
      child.once('exit', () => resolveExit());
      setTimeout(() => resolveExit(), this.options.killGraceMs ?? 3000);
    });
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
    await exited;
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      await new Promise<void>((resolveExit) => {
        child.once('exit', () => resolveExit());
        setTimeout(() => resolveExit(), 1000);
      });
    }
    state.exitCode = child.exitCode;
  }

  private substitute(
    template: string[],
    values: { prompt: string; note: string; task: string; agent: string; session: string; cwd: string },
  ): string[] {
    return template.map((token) =>
      token.replace(/\{(prompt|note|task|agent|session|cwd)\}/g, (_match, key: string) => {
        const map: Record<string, string> = {
          prompt: values.prompt,
          note: values.note,
          task: values.task,
          agent: values.agent,
          session: values.session,
          cwd: values.cwd,
        };
        return map[key] ?? '';
      }),
    );
  }

  private require(session: RunnerSession): SessionState {
    const state = this.sessions.get(session.id);
    if (!state) throw new Error(`unknown runner session ${session.id}`);
    return state;
  }
}

export function parseUsageJson(raw: string): RunnerUsage {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const usage = (parsed['usage'] ?? parsed) as Record<string, unknown>;
  const turns = Number(parsed['turns'] ?? usage['turns'] ?? 0);
  const tokensIn = Number(usage['input_tokens'] ?? usage['tokens_in'] ?? parsed['tokens_in'] ?? 0);
  const tokensOut = Number(usage['output_tokens'] ?? usage['tokens_out'] ?? parsed['tokens_out'] ?? 0);
  return {
    turns: Number.isFinite(turns) ? Math.max(0, Math.trunc(turns)) : 0,
    tokens_in: Number.isFinite(tokensIn) ? Math.max(0, Math.trunc(tokensIn)) : 0,
    tokens_out: Number.isFinite(tokensOut) ? Math.max(0, Math.trunc(tokensOut)) : 0,
  };
}

function guessMime(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    md: 'text/markdown',
    txt: 'text/plain',
    log: 'text/plain',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    pdf: 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}
