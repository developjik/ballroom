import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { Ballroom } from '../src/ballroom.js';
import { startServer, type RunningServer } from './server.js';

/**
 * The hook as a real process, speaking to a real ballroomd over HTTP.
 *
 * This is the Phase 0 experiment 1 half the simulation could not reach: exit 2
 * is what Claude Code reads as "block this tool call and show stderr to the
 * model", so the assertions are about the process exit code and the exact words
 * the model is handed.
 *
 * The hook is spawned asynchronously on purpose: the room lives in this
 * process, and a synchronous wait would block its event loop — the hook would
 * time out and the test would "prove" fail-closed instead of the gate.
 */
const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOOK = join(REPO, 'src', 'hook', 'cli.ts');

interface Node {
  b: Ballroom;
  running: RunningServer;
  base: string;
  key: string;
  taskId: string;
  notifier: { owner: string; agent: string };
}

interface HookRun {
  code: number;
  stderr: string;
  stdout: string;
}

const started: { b: Ballroom; running: RunningServer }[] = [];

async function start(): Promise<Node> {
  const b = new Ballroom({ dbFile: ':memory:', ownerToken: 'owner-token' });
  b.createRoom({ room: 'hook', daily_budget_tokens: 500_000, approval_ttl_minutes: 60 });
  const signup = b.signup({ name: 'claude', kind: 'cli', room: 'hook', gate: 'hook', wake: 'poll' });
  b.confirmAgent(signup.agent.id, signup.confirm_token);
  const notifier = b.signup({ name: 'notifier', kind: 'cli', room: 'hook', gate: 'hook', wake: 'poll' });
  b.confirmAgent(notifier.agent.id, notifier.confirm_token);
  const running = await startServer(b, 'owner-token');
  started.push({ b, running });

  const agent = { owner: 'owner', agent: 'claude' };
  const task = b.createTask({ owner: 'owner', agent: null }, 'hook', {
    title: 'ship the branch',
    kind: 'cli',
    risk: 'irreversible',
    assignee: 'claude',
    check: { kind: 'artifact', target: 'out/evidence.md' },
  });
  b.claim(agent, task.id, { version: task.version, lease_minutes: 10 });
  b.inboxOnce(agent, 0);

  return {
    b,
    running,
    base: running.base,
    key: signup.key,
    taskId: task.id,
    notifier: { owner: 'owner', agent: 'notifier' },
  };
}

afterEach(async () => {
  for (const node of started.splice(0)) {
    await node.running.close();
    node.b.close();
  }
});

function hookEnv(): NodeJS.ProcessEnv {
  return { ...process.env, BALLROOM_GATE_FILE: join(mkdtempSync(join(tmpdir(), 'ballroom-hook-')), 'none.json') };
}

function spawnHook(args: string[], stdin: string): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: REPO, env: hookEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stderr, stdout }));
    child.stdin.end(stdin);
  });
}

function runHook(node: Node | null, payload: unknown, extraArgs: string[] = []): Promise<HookRun> {
  const args = node
    ? ['--import', 'tsx', HOOK, '--room-url', node.base, '--token', node.key, '--task', node.taskId, ...extraArgs]
    : ['--import', 'tsx', HOOK, ...extraArgs];
  return spawnHook(args, typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function runHookAt(base: string, payload: unknown, extraArgs: string[] = []): Promise<HookRun> {
  return spawnHook(
    ['--import', 'tsx', HOOK, '--room-url', base, '--token', 'br_test_key', '--task', 'task_none', ...extraArgs],
    JSON.stringify(payload),
  );
}

function bashPayload(command: string): Record<string, unknown> {
  return {
    session_id: 'sess-1',
    cwd: '/tmp',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command, description: 'run it' },
  };
}

describe('pre-tool hook (real process)', () => {
  test('an unapproved force-push is refused with exit 2 and the approval id', async () => {
    const node = await start();
    const run = await runHook(node, bashPayload('git push --force origin main'));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('BLOCKED');
    expect(run.stderr).toContain('approval required');
    expect(run.stderr).toMatch(/apr_[0-9a-f]{16}/);
    expect(run.stderr).toContain('/v1/approvals/');
    expect(run.stderr).toContain('single-use');

    const approvals = node.b.listApprovals('hook', 'pending');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.task_id).toBe(node.taskId);
    expect(approvals[0]!.normalized_command).toBe('git push --force origin main');
    expect(node.b.requireTask(node.taskId).status).toBe('awaiting_approval');
  });

  test('after the owner approves and the agent reads, the same command passes once', async () => {
    const node = await start();
    expect((await runHook(node, bashPayload('git push --force origin main'))).code).toBe(2);
    const approval = node.b.listApprovals('hook', 'pending')[0]!;

    // Between decision and read the confirm guard fires: the decision wrote
    // events the agent has not been handed yet.
    node.b.decideApproval({ owner: 'owner', agent: null }, approval.id, { decision: 'approve' });
    const guarded = await runHook(node, bashPayload('git push --force origin main'));
    expect(guarded.code).toBe(2);
    expect(guarded.stderr).toContain('have not read');

    node.b.inboxOnce({ owner: 'owner', agent: 'claude' }, 0);
    const allowed = await runHook(node, bashPayload('git push --force origin main'));
    expect(allowed.code).toBe(0);
    expect(allowed.stderr).toBe('');

    // Single use: the next call needs a new approval. Consuming the grant wrote
    // `grant.consumed`, so the agent reads that event first.
    node.b.inboxOnce({ owner: 'owner', agent: 'claude' }, 0);
    const again = await runHook(node, bashPayload('git push origin main --force'));
    expect(again.code).toBe(2);
    expect(again.stderr).toContain('approval required');
    expect(node.b.listApprovals('hook', 'pending')).toHaveLength(1);
  });

  test('an unread event on the task is reported with its sequence', async () => {
    const node = await start();
    node.b.postMessage(node.notifier, 'hook', {
      content: 'read this before you act',
      idem_key: 'hook-unread-1',
      task: node.taskId,
    });
    const run = await runHook(node, bashPayload('gh pr merge 42'));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('have not read');
    expect(run.stderr).toMatch(/seq \d+/);
    const seqs = [...run.stderr.matchAll(/seq ([\d, ]+)/g)];
    const listed = (seqs[0]?.[1] ?? '').split(',').map((part) => Number(part.trim()));
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((seq) => Number.isInteger(seq) && seq > 0)).toBe(true);
  });

  test('a command the table does not consider risky never calls the room', async () => {
    const run = await runHook(null, bashPayload('npm test'));
    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
  });

  test('a risky command with no reachable room fails closed, and --fail-open is explicit', async () => {
    const payload = bashPayload('git push --force origin main');
    const closed = await runHookAt('http://127.0.0.1:9', payload);
    expect(closed.code).toBe(2);
    expect(closed.stderr).toContain('could not be reached');
    expect(closed.stderr).toContain('BALLROOM_HOOK_FAIL_OPEN=1');

    const open = await runHookAt('http://127.0.0.1:9', payload, ['--fail-open']);
    expect(open.code).toBe(0);
    expect(open.stderr).toContain('NOT gated');
  });

  test('the generic event shape works too', async () => {
    const node = await start();
    const run = await runHook(node, {
      event: 'pre_tool_use',
      tool: { name: 'Bash', input: { command: 'npm publish --tag beta' } },
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('publishes a package');
  });

  test('--print-action shows the parsed action without calling the room', async () => {
    const node = await start();
    const run = await runHook(node, bashPayload('kubectl delete pod api-0'), ['--print-action']);
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout) as {
      action: { risk: string; normalized: string };
      config: { task: string };
    };
    expect(parsed.action.risk).toBe('irreversible');
    expect(parsed.action.normalized).toBe('kubectl delete pod api-0');
    expect(parsed.config.task).toBe(node.taskId);
    expect(node.b.listApprovals('hook')).toHaveLength(0);
  });

  test('a malformed event is refused instead of silently allowed', async () => {
    const run = await runHook(null, 'not json');
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('could not read the tool event');
  });
});
