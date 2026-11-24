#!/usr/bin/env node
/**
 * ballroom pre-tool hook.
 *
 * A CLI agent runs this before a tool call and hands it the event JSON on
 * stdin (Claude Code `PreToolUse`, or the generic shape — see protocol.ts).
 *
 *   not a risky call        → exit 0, no network traffic at all
 *   risky, approved         → exit 0
 *   risky, no grant yet     → exit 2 + the approval id and what the owner must do
 *   unread events on task   → exit 2 + the cursor to read
 *   room unreachable        → exit 2 (use --fail-open to let it through)
 *
 * Exit 2 blocks the call; the agent sees this file's stderr as the reason.
 *
 * Run it by hand to see what it would do:
 *   echo '{"tool_name":"Bash","tool_input":{"command":"git push --force"}}' \
 *     | node --import tsx src/hook/cli.ts --room-url http://localhost:8787 \
 *         --task task_x --token "$KEY" --print-action
 */
import { readFileSync } from 'node:fs';
import { resolveHookConfig, hasFlag } from './config.js';
import { askGate, renderDecision, type GateContext } from './gate.js';
import { actionFor, parseHookInput, stableJson, type HookInput } from './protocol.js';

export interface HookRunInput {
  argv: string[];
  stdin: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface HookRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const HELP = `ballroom hook — blocks a risky CLI tool call until the room allows it

usage: ballroom-hook [options] < event.json
  --room-url <url>    ballroomd base URL           (env BALLROOM_ROOM_URL)
  --token <key>       agent key                    (env BALLROOM_TOKEN)
  --task <id>         task the agent is working on (env BALLROOM_TASK)
  --room <name>       room name, for the board link
  --fail-open         allow the call when the room is unreachable
  --gate-all          gate every command, not only the risky table
  --force-risk <r>    record this risk for every gated call
  --print-action      print the parsed action and the gate file, then exit 0
  --help              this text

Exit codes: 0 allow · 2 block (stderr says why).
`;

export async function runHook(input: HookRunInput): Promise<HookRunResult> {
  const { argv } = input;
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    return { exitCode: 0, stdout: HELP, stderr: '' };
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(input.stdin.trim() === '' ? '{}' : input.stdin) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the event is not a JSON object');
    payload = parsed as Record<string, unknown>;
  } catch (error) {
    const message = `[ballroom] BLOCKED — the hook could not read the tool event on stdin: ${(error as Error).message}\n`;
    return { exitCode: 2, stdout: '', stderr: message };
  }

  const hookInput: HookInput = parseHookInput(payload);
  const eventCwd = hookInput.cwd ?? input.cwd;
  const resolved = resolveHookConfig({ argv, env: input.env, cwd: eventCwd });
  const action = actionFor(hookInput, {
    ...(resolved.config?.forceRisk ? { forceRisk: resolved.config.forceRisk } : {}),
    gateAll: resolved.config?.gateAll ?? false,
  });

  if (hasFlag(argv, '--print-action')) {
    return {
      exitCode: 0,
      stdout: `${stableJson({
        event: hookInput.event,
        tool: hookInput.tool,
        session: hookInput.session,
        cwd: hookInput.cwd,
        command: hookInput.command,
        action,
        config: resolved.config
          ? {
              room_url: resolved.config.roomUrl,
              task: resolved.config.task,
              token: `${resolved.config.token.slice(0, 7)}…`,
              room: resolved.config.room,
              fail_open: resolved.config.failOpen,
              gate_all: resolved.config.gateAll,
              force_risk: resolved.config.forceRisk,
              source: resolved.config.source,
            }
          : null,
        config_error: resolved.error,
      })}\n`,
      stderr: '',
    };
  }

  if (resolved.error) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: `[ballroom] BLOCKED — ${resolved.error}. The gate cannot decide without it.\n`,
    };
  }

  if (action === null) {
    // Not the gate's business (a read, a local edit, an unknown tool with no
    // command). No network call: a hook that pings the room on every keystroke
    // is a hook people remove.
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  if (!resolved.config) {
    return {
      exitCode: 0,
      stdout: '',
      stderr:
        '[ballroom] warning: no gate configuration (room URL, task, token). This hook is installed but not attached to a task, so the call is not gated.\n',
    };
  }

  const context: GateContext = {
    roomUrl: resolved.config.roomUrl,
    token: resolved.config.token,
    task: resolved.config.task,
    room: resolved.config.room,
    boardUrl: resolved.config.boardUrl,
  };

  const decision = await askGate(context, action, { timeoutMs: Number(input.env['BALLROOM_HOOK_TIMEOUT_MS'] ?? 5000) });
  const rendered = renderDecision(decision, {
    context,
    action,
    failOpen: resolved.config.failOpen,
    agentName: resolved.config.agent,
  });
  return {
    exitCode: rendered.exitCode,
    stdout: '',
    stderr: rendered.stderr ?? '',
  };
}

function readStdin(): string {
  if (process.stdin.isTTY) return '';
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const result = await runHook({
    argv: process.argv.slice(2),
    stdin: readStdin(),
    env: process.env,
    cwd: process.cwd(),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  main().catch((error) => {
    process.stderr.write(`[ballroom] BLOCKED — the hook failed: ${(error as Error).message}\n`);
    process.exitCode = 2;
  });
}
