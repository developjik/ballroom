/**
 * Where a hook finds its gate: command line, environment, or the per-project
 * gate file its runner wrote (`.ballroom/gate.json`).
 *
 * The order matters for a runner that starts a session and *then* installs the
 * gate: the hook of a tool call reads the file, so a session began before
 * installGate still gates its next risky call.
 *
 *   args  >  environment  >  $BALLROOM_GATE_FILE  >  <cwd>/.ballroom/gate.json
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Risk } from '../types.js';

export interface HookConfig {
  roomUrl: string;
  token: string;
  task: string;
  room: string | null;
  boardUrl: string | null;
  failOpen: boolean;
  gateAll: boolean;
  forceRisk: Risk | null;
  agent: string | null;
  /** Where the values came from — printed by `--print-action`. */
  source: string;
}

export interface ResolveInput {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface ResolveResult {
  config: HookConfig | null;
  /** Set when a gate file existed but could not be used. */
  error: string | null;
}

export const HOOK_FLAGS = [
  '--room-url',
  '--token',
  '--task',
  '--room',
  '--board-url',
  '--fail-open',
  '--gate-all',
  '--force-risk',
  '--print-action',
  '--help',
] as const;

export function flagValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

export function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function boolOf(value: unknown): boolean {
  return value === true || value === '1' || value === 'true' || value === 'yes';
}

const RISKS: Risk[] = ['read', 'write_local', 'irreversible', 'spend', 'outbound'];

function riskOf(value: unknown): Risk | null {
  return typeof value === 'string' && (RISKS as string[]).includes(value) ? (value as Risk) : null;
}

interface GateFile {
  room_url?: unknown;
  roomUrl?: unknown;
  token?: unknown;
  task?: unknown;
  room?: unknown;
  board_url?: unknown;
  fail_open?: unknown;
  gate_all?: unknown;
  force_risk?: unknown;
  agent?: unknown;
}

function readGateFile(path: string): { file: GateFile | null; error: string | null } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { file: null, error: null };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { file: null, error: `${path} is not a JSON object` };
    }
    return { file: parsed as GateFile, error: null };
  } catch (error) {
    return { file: null, error: `${path} is not valid JSON: ${(error as Error).message}` };
  }
}

export function resolveHookConfig(input: ResolveInput): ResolveResult {
  const { argv, env, cwd } = input;
  const gatePath = env['BALLROOM_GATE_FILE'] ?? join(cwd, '.ballroom', 'gate.json');
  const { file, error } = readGateFile(gatePath);

  const pick = (argName: string, envNames: string[], fileKeys: (keyof GateFile)[]): { value: string | null; source: string } => {
    const fromArg = flagValue(argv, argName);
    if (fromArg) return { value: fromArg, source: `arg ${argName}` };
    for (const name of envNames) {
      const value = env[name];
      if (value) return { value, source: `env ${name}` };
    }
    for (const key of fileKeys) {
      const value = file?.[key];
      if (typeof value === 'string' && value !== '') return { value, source: gatePath };
    }
    return { value: null, source: 'missing' };
  };

  const roomUrl = pick('--room-url', ['BALLROOM_ROOM_URL', 'BALLROOM_URL'], ['room_url', 'roomUrl']);
  const token = pick('--token', ['BALLROOM_TOKEN'], ['token']);
  const task = pick('--task', ['BALLROOM_TASK'], ['task']);
  if (!roomUrl.value || !token.value || !task.value) {
    return { config: null, error };
  }
  const room = pick('--room', ['BALLROOM_ROOM'], ['room']);
  const boardUrl = pick('--board-url', ['BALLROOM_BOARD_URL'], ['board_url']);
  const forceRisk = riskOf(flagValue(argv, '--force-risk')) ?? riskOf(env['BALLROOM_GATE_FORCE_RISK']) ?? riskOf(file?.force_risk);

  return {
    config: {
      roomUrl: roomUrl.value.replace(/\/+$/, ''),
      token: token.value,
      task: task.value,
      room: room.value,
      boardUrl: boardUrl.value,
      failOpen: hasFlag(argv, '--fail-open') || boolOf(env['BALLROOM_HOOK_FAIL_OPEN']) || boolOf(file?.fail_open),
      gateAll: hasFlag(argv, '--gate-all') || boolOf(env['BALLROOM_GATE_ALL']) || boolOf(file?.gate_all),
      forceRisk,
      agent: typeof file?.agent === 'string' ? file.agent : (env['BALLROOM_AGENT'] ?? null),
      source: `${roomUrl.source}`,
    },
    error,
  };
}
