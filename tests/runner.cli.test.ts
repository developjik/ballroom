import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { CliRunnerAdapter } from '../src/runner/cli.js';
import { DamonRunnerAdapter, damonUsageParser } from '../src/runner/damon.js';
import { assertRunnerConformance, runRunnerConformance } from '../src/runner/adapter.js';
import { gateFilePathFor, settingsPathFor } from '../src/hook/install.js';

const MOCK = fileURLToPath(new URL('./fixtures/mock-agent.mjs', import.meta.url));

function project(): string {
  return mkdtempSync(join(tmpdir(), 'ballroom-cli-'));
}

/** The adapter in front of the fixture CLI; no room, so the hook stays quiet. */
function mockAdapter(dir: string, options: { gateWaitMs?: number } = {}): CliRunnerAdapter {
  return new CliRunnerAdapter({
    name: 'mock',
    command: [process.execPath, MOCK, '--prompt', '{prompt}', '--gate-wait', String(options.gateWaitMs ?? 50)],
    resumeCommand: [process.execPath, MOCK, '--prompt', '{note}', '--resume', '{session}', '--gate-wait', String(options.gateWaitMs ?? 50)],
    outputs: ['out/evidence.md'],
    cwd: dir,
    installHook: false,
  });
}

describe('CliRunnerAdapter', () => {
  test('passes the public runner conformance suite', async () => {
    const dir = project();
    const checks = await runRunnerConformance(() => mockAdapter(dir));
    const failed = checks.filter((check) => !check.ok);
    expect(failed).toEqual([]);
    expect(checks.length).toBeGreaterThanOrEqual(10);
    assertRunnerConformance(checks);
  });

  test('a turn runs in the task cwd and its outputs become artifacts', async () => {
    const dir = project();
    const adapter = mockAdapter(dir);
    const session = await adapter.start({ agent: 'claude', task: 'task_1', prompt: 'ship the branch' });
    await waitFor(adapter, session, 'idle', 10_000);

    const log = adapter.inspect(session).log;
    expect(log).toContain('[mock-agent] turn start');
    expect(log).toContain('done');

    const artifacts = await adapter.collectArtifacts(session);
    const names = artifacts.map((artifact) => artifact.name);
    expect(names).toContain(`run-${session.id}.log`);
    expect(names).toContain('evidence.md');
    expect(artifacts.find((artifact) => artifact.name === 'evidence.md')!.content.toString('utf8')).toContain(
      'git push --force origin main',
    );
  });

  test('installGate writes the project hook and the per-session gate file, once', async () => {
    const dir = project();
    const adapter = new CliRunnerAdapter({
      command: [process.execPath, MOCK, '--prompt', '{prompt}', '--gate-wait', '50'],
      cwd: dir,
      installHook: true,
    });
    const session = await adapter.start({ agent: 'claude', task: 'task_9', prompt: 'do it' });
    await adapter.installGate(session, { roomUrl: 'http://127.0.0.1:8787', task: 'task_9', token: 'br_key' });
    await adapter.installGate(session, { roomUrl: 'http://127.0.0.1:8787', task: 'task_9', token: 'br_key' });

    const settings = JSON.parse(readFileSync(settingsPathFor(dir), 'utf8')) as {
      hooks: { PreToolUse: { hooks: { command: string }[] }[] };
    };
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    const gate = JSON.parse(readFileSync(gateFilePathFor(dir), 'utf8')) as Record<string, string>;
    expect(gate['task']).toBe('task_9');
    expect(gate['session']).toBe(session.id);
    await adapter.stop(session);
  });

  test('resume after an idle turn starts the resume command', async () => {
    const dir = project();
    const adapter = mockAdapter(dir);
    const session = await adapter.start({ agent: 'claude', task: 'task_2', prompt: 'first turn' });
    await waitFor(adapter, session, 'idle', 10_000);
    await adapter.resume(session, 'Approval granted (one use): git push --force origin main');
    expect(await adapter.status(session)).toBe('running');
    await waitFor(adapter, session, 'idle', 10_000);
    expect(adapter.inspect(session).runs).toBe(2);
    expect(adapter.inspect(session).log).toContain('resume cli-');
    expect(readdirSync(join(dir, 'out')).sort()).toContain('evidence.md');
  });

  test('stop ends the process and the session is exited', async () => {
    const dir = project();
    const adapter = new CliRunnerAdapter({
      command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      cwd: dir,
      installHook: false,
      killGraceMs: 500,
    });
    const session = await adapter.start({ agent: 'claude', task: 'task_3', prompt: 'wait' });
    expect(await adapter.status(session)).toBe('running');
    await adapter.stop(session);
    expect(await adapter.status(session)).toBe('exited');
    await adapter.stop(session);
    expect(await adapter.status(session)).toBe('exited');
  });

  test('usage comes from a usage command when one is configured', async () => {
    const dir = project();
    const adapter = new CliRunnerAdapter({
      name: 'stub',
      command: [process.execPath, '-e', 'process.exit(0)'],
      usageCommand: [
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify({turns: 3, usage: {input_tokens: 120, output_tokens: 40}}))',
      ],
      cwd: dir,
      installHook: false,
    });
    const session = await adapter.start({ agent: 'claude', task: 'task_4', prompt: 'go' });
    await waitFor(adapter, session, 'idle', 10_000);
    expect(await adapter.usage(session)).toEqual({ turns: 3, tokens_in: 120, tokens_out: 40 });
  });

  test('a missing binary is reported as an exited session, not a silent success', async () => {
    const adapter = new CliRunnerAdapter({ command: ['definitely-not-a-real-cli', '{prompt}'], installHook: false });
    const session = await adapter.start({ agent: 'claude', task: 't', prompt: 'x' });
    await waitFor(adapter, session, 'exited', 10_000);
    expect(adapter.inspect(session).log).toContain('[spawn error]');
  });
});

describe('DamonRunnerAdapter', () => {
  test('maps turns onto the room usage and reports no invented token split', () => {
    expect(damonUsageParser(JSON.stringify({ sessionId: 's1', contextUsed: 12000, contextSize: 200000, costUsd: 0.12, turns: 4 }))).toEqual({
      turns: 4,
      tokens_in: 0,
      tokens_out: 0,
    });
  });

  test('discovers the session id from `damon sessions --json` after the spawn', async () => {
    const dir = project();
    // A stub `damon` on disk: `prompt` prints a turn and exits, `sessions` lists
    // one session created now, `usage` reports turns.
    const script = join(dir, 'damon');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        'case "$1" in',
        '  prompt) echo "[damon] turn"; exit 0 ;;',
        '  sessions) echo "[{\\"sessionId\\":\\"sess_live\\",\\"createdAt\\":\\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\\",\\"backend\\":\\"claude\\",\\"title\\":\\"ballroom\\"}]"; exit 0 ;;',
        '  usage) echo "{\\"sessionId\\":\\"sess_live\\",\\"contextUsed\\":10,\\"contextSize\\":100,\\"costUsd\\":0,\\"turns\\":2}"; exit 0 ;;',
        'esac',
        'exit 1',
      ].join('\n'),
      { mode: 0o755 },
    );
    const adapter = new DamonRunnerAdapter({ command: script, cwd: dir, installHook: false, discoverTimeoutMs: 1000, pollMs: 50 });
    const session = await adapter.start({ agent: 'claude', task: 'task_d', prompt: 'go' });
    expect(session.backendRef).toBe('sess_live');
    await waitFor(adapter, session, 'idle', 10_000);
    expect(await adapter.usage(session)).toEqual({ turns: 2, tokens_in: 0, tokens_out: 0 });
    expect(existsSync(join(dir, 'damon'))).toBe(true);
  });
});

async function waitFor(
  adapter: { status: (session: { id: string; agent: string; task: string }) => Promise<string> },
  session: { id: string; agent: string; task: string },
  wanted: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await adapter.status(session)) === wanted) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session ${session.id} never reached ${wanted}`);
}
