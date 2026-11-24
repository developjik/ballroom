/**
 * Hook protocol — what a CLI agent hands its pre-tool hook, and what the hook
 * decides to ask the room about.
 *
 * Two shapes are accepted, because there is no single standard yet:
 *
 *   1. Claude Code `PreToolUse` (the shape this repo targets first):
 *        { session_id, cwd, hook_event_name: "PreToolUse",
 *          tool_name: "Bash", tool_input: { command: "git push --force" } }
 *      Exit 2 blocks the call and Claude Code shows stderr to the model.
 *
 *   2. A generic CLI/MCP tool event, so the same hook works for other runners:
 *        { event: "pre_tool_use", tool: { name: "Bash", input: { command: "…" } } }
 *        { tool_name: "Bash", input: { command: "…" } }
 *        { name: "run_shell", arguments: { command: "…" } }
 *
 * Only the *tool call* is read. Nothing here interprets prose, and an unknown
 * tool with no command is not gated — a hook that blocked everything it did
 * not understand would be turned off after the first hour.
 */
import { normalizeCommand } from '../commands.js';
import type { Risk } from '../types.js';
import { sha256 } from '../util.js';

export interface HookInput {
  event: string;
  tool: string;
  session: string | null;
  cwd: string | null;
  /** The shell command, when the tool call carries one. */
  command: string | null;
  raw: Record<string, unknown>;
}

export interface HookAction {
  tool: string;
  command: string | null;
  normalized: string | null;
  actionHash: string;
  risk: Risk;
  reason: string;
  preview: string;
}

export interface Classification {
  risk: Risk;
  reason: string;
}

/**
 * The gate table. Ordered: the first match wins, and `irreversible` comes
 * before `spend` before `outbound` so a `npm publish` is never filed as merely
 * outbound. Each pattern is matched against the *normalised* command
 * (`src/commands.ts`), where the subcommand sits first and flags are sorted —
 * so `git push origin main --force` and `git push --force origin main` classify
 * the same.
 *
 * `read` and `write_local` are not listed: an ordinary edit or test run is not
 * the gate's business, and the hook returns without a network call for it.
 */
const RULES: { risk: Risk; pattern: RegExp; reason: string }[] = [
  { risk: 'irreversible', pattern: /^git\s+push\b.*(?:--force|-f)\b/, reason: 'force-push rewrites remote history' },
  { risk: 'irreversible', pattern: /^git\s+push\b.*--delete\b/, reason: 'deletes a remote branch' },
  { risk: 'irreversible', pattern: /^git\s+reset\b.*--hard\b/, reason: 'discards local commits' },
  { risk: 'irreversible', pattern: /^git\s+clean\b.*-\w*f/, reason: 'deletes untracked files' },
  { risk: 'irreversible', pattern: /^git\s+branch\b.*-d\b/, reason: 'deletes a branch' },
  { risk: 'irreversible', pattern: /^rm\b.*-\w*[rf]/, reason: 'deletes files' },
  { risk: 'irreversible', pattern: /^gh\s+repo\s+delete\b/, reason: 'deletes a repository' },
  { risk: 'irreversible', pattern: /^gh\s+pr\s+merge\b/, reason: 'merges a pull request' },
  { risk: 'irreversible', pattern: /^kubectl\s+delete\b/, reason: 'deletes cluster objects' },
  { risk: 'irreversible', pattern: /^docker\s+(?:rm|rmi|volume\s+rm|system\s+prune)\b/, reason: 'deletes containers, images or volumes' },
  { risk: 'irreversible', pattern: /^chmod\b.*\b(?:777|0777|666|0666)\b/, reason: 'opens permissions to everyone' },
  { risk: 'irreversible', pattern: /^(?:shutdown|reboot|halt|poweroff)\b/, reason: 'takes the machine down' },
  { risk: 'irreversible', pattern: /^sudo\b/, reason: 'runs as another user' },
  { risk: 'irreversible', pattern: /^(?:drop|truncate)\s+table\b/, reason: 'destroys data' },

  { risk: 'spend', pattern: /^(?:npm|yarn|pnpm)\s+publish\b/, reason: 'publishes a package' },
  { risk: 'spend', pattern: /^gh\s+release\s+create\b/, reason: 'creates a release' },
  { risk: 'spend', pattern: /^terraform\s+(?:apply|destroy)\b/, reason: 'changes infrastructure' },
  { risk: 'spend', pattern: /^(?:aws|gcloud|az|flyctl|fly|heroku)\b/, reason: 'calls a cloud control plane that can bill' },
  { risk: 'spend', pattern: /^kubectl\s+apply\b/, reason: 'applies cluster changes' },
  { risk: 'spend', pattern: /^stripe\b/, reason: 'touches payments' },

  { risk: 'outbound', pattern: /^git\s+push\b/, reason: 'pushes to a remote' },
  { risk: 'outbound', pattern: /^gh\s+(?:pr|issue)\s+(?:create|comment|edit|close|reopen)\b/, reason: 'writes to GitHub on the owner’s name' },
  { risk: 'outbound', pattern: /^gh\s+api\b.*(?:-X|--method)\s+(?:post|patch|put|delete)\b/, reason: 'writes to the GitHub API' },
  { risk: 'outbound', pattern: /^curl\b.*(?:--data\b|-d\s|--upload-file\b|-X\s*(?:post|put|patch|delete)\b)/, reason: 'sends data to a remote host' },
  { risk: 'outbound', pattern: /^wget\b.*--post/, reason: 'sends data to a remote host' },
  { risk: 'outbound', pattern: /^(?:ssh|scp|sftp)\b/, reason: 'reaches another machine' },
  { risk: 'outbound', pattern: /^rsync\b.*\S+:/, reason: 'reaches another machine' },
  { risk: 'outbound', pattern: /^(?:mail|sendmail|mutt)\b/, reason: 'sends mail' },
];

export function classifyCommand(command: string): Classification | null {
  const normalized = normalizeCommand(command).toLowerCase();
  if (normalized === '') return null;
  for (const rule of RULES) {
    if (rule.pattern.test(normalized)) return { risk: rule.risk, reason: rule.reason };
  }
  return null;
}

type Unknown = Record<string, unknown>;

function isRecord(value: unknown): value is Unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const found = str(value);
    if (found) return found;
  }
  return null;
}

function commandFrom(value: unknown): string | null {
  const direct = firstString(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string => typeof part === 'string');
    return parts.length > 0 ? parts.join(' ') : null;
  }
  return null;
}

function toolNameOf(raw: Unknown): string {
  const tool = raw['tool'];
  const toolRecord = isRecord(tool) ? tool : null;
  return (
    firstString(raw['tool_name'], raw['toolName'], typeof tool === 'string' ? tool : null, toolRecord?.['name'], raw['name']) ??
    'Bash'
  );
}

function commandOf(raw: Unknown): string | null {
  const tool = isRecord(raw['tool']) ? raw['tool'] : null;
  const toolInput = isRecord(raw['tool_input']) ? raw['tool_input'] : null;
  const input = isRecord(raw['input']) ? raw['input'] : null;
  const args = isRecord(raw['arguments']) ? raw['arguments'] : null;
  const toolArgs = tool && isRecord(tool['arguments']) ? tool['arguments'] : null;
  const toolToolInput = tool && isRecord(tool['input']) ? tool['input'] : null;
  return (
    commandFrom(toolInput?.['command']) ??
    commandFrom(input?.['command']) ??
    commandFrom(args?.['command']) ??
    commandFrom(toolArgs?.['command']) ??
    commandFrom(toolToolInput?.['command']) ??
    commandFrom(toolInput?.['cmd']) ??
    commandFrom(raw['command']) ??
    commandFrom(args?.['cmd']) ??
    commandFrom(toolInput?.['args']) ??
    commandFrom(args?.['args'])
  );
}

export function parseHookInput(raw: Unknown): HookInput {
  const tool = isRecord(raw['tool']) ? raw['tool'] : null;
  const toolInput = isRecord(raw['tool_input']) ? raw['tool_input'] : null;
  const event =
    firstString(raw['hook_event_name'], raw['event'], raw['event_name'], raw['type']) ?? 'PreToolUse';
  return {
    event,
    tool: toolNameOf(raw),
    session: firstString(raw['session_id'], raw['sessionId'], raw['session'], tool?.['session_id']),
    cwd: firstString(raw['cwd'], toolInput?.['cwd']),
    command: commandOf(raw),
    raw,
  };
}

/** Stable JSON so the same tool input always hashes the same. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const entries = Object.entries(value as Unknown)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

/**
 * The hash a pending approval is keyed by. It covers the tool name and the
 * canonical command, so a re-run with flags in a different order asks for the
 * *same* approval instead of opening a second one.
 */
export function actionHashFor(input: HookInput, normalized: string | null): string {
  const material = normalized ?? stableJson(input.raw['tool_input'] ?? input.raw['arguments'] ?? {});
  return sha256(`${input.tool.toLowerCase()}\u0000${material}`);
}

export interface ActionOptions {
  /** Classify even a `read`/`write_local` call as this risk. */
  forceRisk?: Risk | null;
  /** Gate every command, including ones the table does not know. */
  gateAll?: boolean;
}

/** Returns null when this call is not the gate's business. */
export function actionFor(input: HookInput, options: ActionOptions = {}): HookAction | null {
  if (input.command === null) return null;
  const normalized = normalizeCommand(input.command);
  if (normalized === '') return null;
  const classified = classifyCommand(input.command);
  const risk: Risk | null = options.forceRisk ?? classified?.risk ?? (options.gateAll ? 'write_local' : null);
  if (risk === null) return null;
  const reason = options.forceRisk ? 'every command is gated for this session' : (classified?.reason ?? 'every command is gated for this session');
  return {
    tool: input.tool,
    command: input.command,
    normalized,
    actionHash: actionHashFor(input, normalized),
    risk,
    reason,
    preview: input.command.length > 500 ? `${input.command.slice(0, 500)}…` : input.command,
  };
}
