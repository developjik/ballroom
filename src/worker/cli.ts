#!/usr/bin/env node
/**
 * The runner process: one worker, one agent key, one room.
 *
 *   npm run worker -- --url http://localhost:8787 --token "$KEY" --agent claude --runner claude
 *
 * `--runner claude` drives the real Claude Code CLI, `--runner damon` the damon
 * daemon CLI, and `--runner mock` the fixture this repository uses in tests and
 * in `scripts/verify-phase0-mac.sh`, so the loop can be proven on a machine
 * where no vendor CLI is installed or signed in.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliRunnerAdapter, type CliRunnerOptions } from '../runner/cli.js';
import { DamonRunnerAdapter } from '../runner/damon.js';
import type { RunnerAdapter } from '../runner/adapter.js';
import { Worker } from './loop.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT = join(HERE, '..', '..', 'tests', 'fixtures', 'mock-agent.mjs');

const HELP = `ballroom worker — long-poll the room, run the tasks assigned to you

usage: ballroom-worker --token <key> [options]
  --url <url>        ballroomd base URL (env BALLROOM_ROOM_URL, default http://localhost:8787)
  --token <key>      agent key (env BALLROOM_TOKEN)
  --agent <id>       this agent's id (env BALLROOM_AGENT)
  --room <name>      room name, for messages only
  --runner <kind>    claude | damon | mock (default claude)
  --cwd <dir>        working directory handed to the runner
  --lease <min>      lease length, default 5
  --wait <sec>       long-poll length, default 30
  --claim-open       also claim tasks that have no assignee yet
  --once             handle one poll, then exit
  --help             this text
`;

function arg(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

function buildRunner(kind: string, options: { cwd?: string }): RunnerAdapter {
  if (kind === 'mock') {
    const cli: CliRunnerOptions = {
      name: 'mock',
      command: [process.execPath, MOCK_AGENT, '--prompt', '{prompt}'],
      resumeCommand: [process.execPath, MOCK_AGENT, '--prompt', '{note}', '--resume', '{session}'],
      outputs: ['out/evidence.md'],
      ...(options.cwd ? { cwd: options.cwd } : {}),
    };
    return new CliRunnerAdapter(cli);
  }
  if (kind === 'damon') {
    return new DamonRunnerAdapter({
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(process.env['DAMON_URL'] ? { url: process.env['DAMON_URL'] } : {}),
      ...(process.env['DAMON_TOKEN'] ? { token: process.env['DAMON_TOKEN'] } : {}),
    });
  }
  if (kind !== 'claude') throw new Error(`unknown runner "${kind}" (claude | damon | mock)`);
  return new CliRunnerAdapter({
    name: 'claude',
    command: ['claude', '-p', '{prompt}', '--output-format', 'json'],
    resumeCommand: ['claude', '-p', '--resume', '{session}', '{note}', '--output-format', 'json'],
    sessionIdPattern: /"session_id"\s*:\s*"([^"]+)"/,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  const baseUrl = arg(argv, '--url') ?? process.env['BALLROOM_ROOM_URL'] ?? 'http://localhost:8787';
  const token = arg(argv, '--token') ?? process.env['BALLROOM_TOKEN'] ?? '';
  const agent = arg(argv, '--agent') ?? process.env['BALLROOM_AGENT'] ?? null;
  if (!token) {
    process.stderr.write('a token is required: --token <agent key> or BALLROOM_TOKEN\n');
    process.exitCode = 1;
    return;
  }
  const cwd = arg(argv, '--cwd') ?? process.cwd();
  const kind = arg(argv, '--runner') ?? 'claude';
  const once = argv.includes('--once');

  const worker = new Worker({
    baseUrl,
    token,
    ...(agent ? { agent } : {}),
    ...(arg(argv, '--room') ? { room: arg(argv, '--room')! } : {}),
    runner: buildRunner(kind, { cwd }),
    cwd,
    leaseMinutes: Number(arg(argv, '--lease') ?? 5),
    waitSeconds: Number(arg(argv, '--wait') ?? 30),
    claimOpen: argv.includes('--claim-open'),
    log: (line) => process.stdout.write(`${line}\n`),
  });

  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      process.stdout.write(`${signal} received, leaving the room cleanly\n`);
      controller.abort();
    });
  }
  if (once) {
    const result = await worker.pollOnce();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`ballroom worker: ${baseUrl} as ${agent ?? '(unknown agent)'} with the ${kind} runner\n`);
  await worker.loop(controller.signal);
}

main().catch((error) => {
  process.stderr.write(`worker failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
