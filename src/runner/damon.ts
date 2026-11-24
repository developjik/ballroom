/**
 * damon-agent-core adapter — mapped onto the CLI that actually exists.
 *
 * Source of truth: `developjik/damon-agent-core` v0.9.0, `src/bin/damon.rs`
 * (checked in this workspace at work/damon-agent-core). What that file shows:
 *
 *   damon [--url ws://…] [--token …] [--json] <command>
 *     prompt <text> [--session <id>] [--backend <id>]   one-shot turn
 *     sessions --json                                   [{sessionId, createdAt, backend, title}]
 *     usage [--session <id>] --json                      {sessionId, contextUsed, contextSize, costUsd, turns}
 *     steer <id> <text…>                                 steer a running turn
 *     delete <id>                                        deletes a session and its history
 *     health                                             GET /health
 *
 * Phase 1 guessed `damon session create --project …`; no such subcommand exists,
 * so this file was rewritten against the binary above. The mapping:
 *
 *   start   `damon prompt <prompt> --backend <agent> --json`
 *   resume  live turn → steer over stdin; finished turn → `damon prompt <note> --session <id>`
 *   stop    `/cancel` on stdin (damon's documented cancel), then SIGTERM
 *   status  the `damon` client process: alive = running, exit 0 = idle, signalled = exited
 *   usage   `damon usage --session <id> --json`
 *   installGate  the room's pre-tool hook into the project (damon has no hook
 *                installer of its own; its permission relay is a separate path)
 *
 * Two honest gaps, both marked in the code:
 *   - `damon prompt` does not print the session id it created, so the adapter
 *     discovers it by polling `damon sessions --json` for an entry created after
 *     the spawn. If discovery times out, usage falls back to the local turn
 *     count and `backendRef` stays unset.
 *   - damon reports context size and cost, not a per-turn in/out token split, so
 *     `tokens_in`/`tokens_out` are 0 and the room's token budget is not fed by
 *     this adapter (the turn budget still is).
 *
 * NOT verified at runtime here: there is no `damond` or `damon` binary in this
 * environment, so every call below is a mapping proven against the source and
 * exercised against a stub, not against a live daemon.
 */
import { CliRunnerAdapter, type CliRunnerOptions, type DiscoveryContext } from './cli.js';
import type { RunnerUsage, StartInput } from './adapter.js';

export type Exec = (argv: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface DamonOptions {
  name?: string;
  /** The `damon` binary (default `damon`). */
  command?: string;
  /** Daemon WS URL; omitted → damon's own default (~/.damon/daemon.json, ws://127.0.0.1:9470/ws). */
  url?: string;
  /** Auth token (damon also reads DAMON_TOKEN). */
  token?: string;
  /** Backend id given to `--backend`; defaults to the agent id. */
  backend?: string;
  cwd?: string;
  installHook?: boolean;
  /** Poll interval while discovering the session id. Default 200ms. */
  pollMs?: number;
  /** How long to wait for the session id to appear. Default 4000ms. */
  discoverTimeoutMs?: number;
  env?: Record<string, string>;
}

const DEFAULT_DISCOVER_MS = 4000;
const DEFAULT_POLL_MS = 200;

interface DamonSessionRow {
  sessionId?: string;
  createdAt?: string;
  backend?: string;
  title?: string;
}

export function damonConnectionArgs(options: { url?: string; token?: string }): string[] {
  return [...(options.url ? ['--url', options.url] : []), ...(options.token ? ['--token', options.token] : [])];
}

export function damonStartArgs(
  input: StartInput,
  options: { command?: string; url?: string; token?: string; backend?: string } = {},
): string[] {
  return [
    options.command ?? 'damon',
    ...damonConnectionArgs(options),
    'prompt',
    input.prompt,
    '--backend',
    options.backend ?? input.agent,
    '--json',
  ];
}

export function damonResumeArgs(
  session: { id: string; backendRef?: string },
  note: string,
  options: { command?: string; url?: string; token?: string } = {},
): string[] {
  return [
    options.command ?? 'damon',
    ...damonConnectionArgs(options),
    'prompt',
    note,
    '--session',
    session.backendRef ?? session.id,
    '--json',
  ];
}

export function damonUsageArgs(
  session: { id: string; backendRef?: string },
  options: { command?: string; url?: string; token?: string } = {},
): string[] {
  return [
    options.command ?? 'damon',
    ...damonConnectionArgs(options),
    'usage',
    '--session',
    session.backendRef ?? session.id,
    '--json',
  ];
}

export function damonSessionsArgs(options: { command?: string; url?: string; token?: string } = {}): string[] {
  return [options.command ?? 'damon', ...damonConnectionArgs(options), 'sessions', '--json'];
}

/** `session.usage` per-session shape → the room's usage triple. */
export function damonUsageParser(raw: string): RunnerUsage {
  const parsed = JSON.parse(raw) as { turns?: number; contextUsed?: number };
  const turns = Number(parsed.turns ?? 0);
  return {
    turns: Number.isFinite(turns) ? Math.max(0, Math.trunc(turns)) : 0,
    // damon exposes context size, not an input/output split; report 0 rather
    // than invent a number the room would bill against.
    tokens_in: 0,
    tokens_out: 0,
  };
}

export class DamonRunnerAdapter extends CliRunnerAdapter {
  private readonly damon: DamonOptions;

  constructor(options: DamonOptions = {}) {
    const damon: DamonOptions = { ...options };
    const cliOptions: CliRunnerOptions = {
      name: options.name ?? 'damon',
      command: damonStartArgs(
        { agent: '{agent}', task: '{task}', prompt: '{prompt}', ...(options.cwd ? { cwd: options.cwd } : {}) },
        { ...damon },
      ),
      resumeCommand: damonResumeArgs({ id: '{session}', backendRef: '{session}' }, '{note}', { ...damon }),
      usageCommand: damonUsageArgs({ id: '{session}', backendRef: '{session}' }, { ...damon }),
      usageParser: damonUsageParser,
      cancelText: '/cancel',
      installHook: options.installHook,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    };
    super(cliOptions);
    this.damon = damon;
  }

  /**
   * `damon prompt` prints the turn, not the session id, so the adapter asks the
   * daemon for the sessions that appeared after this start and takes the newest.
   */
  protected override async discoverSessionId(context: DiscoveryContext): Promise<string | undefined> {
    const deadline = Date.now() + (this.damon.discoverTimeoutMs ?? DEFAULT_DISCOVER_MS);
    const since = context.startedAt - 1000;
    while (Date.now() < deadline) {
      try {
        const stdout = await context.exec(damonSessionsArgs({ ...this.damon }));
        const rows = JSON.parse(stdout) as DamonSessionRow[];
        const fresh = rows
          .filter((row): row is DamonSessionRow & { sessionId: string } => typeof row.sessionId === 'string')
          .filter((row) => {
            const created = row.createdAt ? Date.parse(row.createdAt) : Number.NaN;
            return Number.isFinite(created) ? created >= since : true;
          })
          .sort((left, right) => (Date.parse(right.createdAt ?? '') || 0) - (Date.parse(left.createdAt ?? '') || 0));
        const candidate = fresh[0];
        if (candidate) return candidate.sessionId;
      } catch {
        // A daemon that is not up yet will answer on the next poll.
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, this.damon.pollMs ?? DEFAULT_POLL_MS));
    }
    return undefined;
  }
}
