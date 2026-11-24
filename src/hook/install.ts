/**
 * installGate — attach the pre-tool hook to a project without trampling the
 * settings the owner already has.
 *
 * Target: `.claude/settings.local.json` (Claude Code's project-local settings),
 * the shape
 *
 *   { "hooks": { "PreToolUse": [
 *       { "matcher": "Bash", "hooks": [ { "type": "command", "command": "…" } ] }
 *   ] } }
 *
 * Rules this follows, because it edits a file someone else owns:
 *   - every unknown key and every other hook is preserved;
 *   - the entry is identified by a marker inside the command, so installing
 *     twice leaves one entry and uninstalling removes exactly that one;
 *   - a file that is not valid JSON is refused, never overwritten;
 *   - the write is atomic (temp file + rename) and the file is 0600, because
 *     the gate command may embed a key.
 *
 * The gate file it writes next to it (`.ballroom/gate.json`) is what the hook
 * reads at tool-call time: room URL, task, token. The runner writes it per
 * session, so a session started before installGate still gates its next call.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MARKER = 'ballroom-gate';

export interface ClaudeHookCommand {
  type: 'command';
  command: string;
}

export interface ClaudeHookEntry {
  matcher?: string;
  hooks: ClaudeHookCommand[];
  [key: string]: unknown;
}

export interface ClaudeSettings {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GateFile {
  room_url: string;
  task: string;
  token: string;
  room?: string;
  board_url?: string;
  agent?: string;
  session?: string;
  fail_open?: boolean;
  gate_all?: boolean;
  installed_at?: string;
}

export interface InstallGateOptions {
  /** Project directory that owns `.claude/settings.local.json`. */
  dir?: string;
  /** Override the settings file (tests, unusual layouts). */
  settingsPath?: string;
  /** Hook event name; Claude Code uses `PreToolUse`. */
  event?: string;
  /** Tool matcher; `Bash` is where the commands live. */
  matcher?: string;
  /** Full shell command the hook runs. */
  command: string;
  marker?: string;
  /** When given, writes `.ballroom/gate.json` for the hook to read. */
  gate?: Omit<GateFile, 'installed_at'> & { installed_at?: string };
  /** Skip writing the gate file even when `gate` is given. */
  writeGateFile?: boolean;
}

export interface InstallResult {
  settingsPath: string;
  changed: boolean;
  entry: ClaudeHookEntry;
  gatePath: string | null;
}

export interface UninstallResult {
  settingsPath: string;
  changed: boolean;
  removed: number;
}

export function settingsPathFor(dir: string): string {
  return join(resolve(dir), '.claude', 'settings.local.json');
}

export function gateFilePathFor(dir: string): string {
  return join(resolve(dir), '.ballroom', 'gate.json');
}

export function readSettings(settingsPath: string): ClaudeSettings {
  if (!existsSync(settingsPath)) return {};
  const raw = readFileSync(settingsPath, 'utf8');
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${settingsPath} is not valid JSON (${(error as Error).message}); refusing to rewrite it`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${settingsPath} is not a JSON object; refusing to rewrite it`);
  }
  return parsed as ClaudeSettings;
}

function writeSettings(settingsPath: string, settings: ClaudeSettings): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  const temporary = `${settingsPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, settingsPath);
  chmodSync(settingsPath, 0o600);
}

export function writeGateFile(dir: string, gate: GateFile): string {
  const path = gateFilePathFor(dir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(gate, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function hookEntries(settings: ClaudeSettings, event: string): ClaudeHookEntry[] {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  const entries = (hooks as Record<string, unknown>)[event];
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry): entry is ClaudeHookEntry => {
    return entry !== null && typeof entry === 'object' && Array.isArray((entry as ClaudeHookEntry).hooks);
  });
}

function hasMarker(entry: ClaudeHookEntry, marker: string): boolean {
  return entry.hooks.some((hook) => typeof hook.command === 'string' && hook.command.includes(marker));
}

export function isInstalled(settingsPath: string, marker: string = DEFAULT_MARKER, event = 'PreToolUse'): boolean {
  const settings = readSettings(settingsPath);
  return hookEntries(settings, event).some((entry) => hasMarker(entry, marker));
}

export function installGate(options: InstallGateOptions): InstallResult {
  const dir = resolve(options.dir ?? process.cwd());
  const settingsPath = options.settingsPath ? resolve(options.settingsPath) : settingsPathFor(dir);
  const event = options.event ?? 'PreToolUse';
  const matcher = options.matcher ?? 'Bash';
  const marker = options.marker ?? DEFAULT_MARKER;
  const settings = readSettings(settingsPath);

  let changed = false;
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? (settings.hooks as Record<string, unknown>)
    : {};

  const existing = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
  const entries = existing.filter((entry): entry is ClaudeHookEntry => {
    return entry !== null && typeof entry === 'object' && Array.isArray((entry as ClaudeHookEntry).hooks);
  });

  let target = entries.find((entry) => hasMarker(entry, marker));
  if (!target) {
    target = { matcher, hooks: [{ type: 'command', command: options.command }] };
    existing.push(target);
    hooks[event] = existing;
    settings.hooks = hooks;
    changed = true;
  } else {
    // Keep settings and version pins current: refresh the command in place.
    const index = target.hooks.findIndex((hook) => typeof hook.command === 'string' && hook.command.includes(marker));
    if (index >= 0 && target.hooks[index]!.command !== options.command) {
      target.hooks[index] = { type: 'command', command: options.command };
      changed = true;
    }
  }

  let gatePath: string | null = null;
  if (options.gate && options.writeGateFile !== false) {
    gatePath = writeGateFile(dir, { ...options.gate, installed_at: options.gate.installed_at ?? new Date().toISOString() });
  }
  if (changed) writeSettings(settingsPath, settings);
  return { settingsPath, changed, entry: target, gatePath };
}

export function uninstallGate(
  options: { dir?: string; settingsPath?: string; event?: string; marker?: string; keepGateFile?: boolean } = {},
): UninstallResult {
  const dir = resolve(options.dir ?? process.cwd());
  const settingsPath = options.settingsPath ? resolve(options.settingsPath) : settingsPathFor(dir);
  const event = options.event ?? 'PreToolUse';
  const marker = options.marker ?? DEFAULT_MARKER;
  const settings = readSettings(settingsPath);
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return { settingsPath, changed: false, removed: 0 };
  }
  const events = hooks as Record<string, unknown>;
  const existing = Array.isArray(events[event]) ? (events[event] as unknown[]) : [];
  let removed = 0;
  const kept: unknown[] = [];
  for (const entry of existing) {
    if (entry === null || typeof entry !== 'object' || !Array.isArray((entry as ClaudeHookEntry).hooks)) {
      kept.push(entry);
      continue;
    }
    const record = entry as ClaudeHookEntry;
    const before = record.hooks.length;
    record.hooks = record.hooks.filter((hook) => !(typeof hook.command === 'string' && hook.command.includes(marker)));
    removed += before - record.hooks.length;
    if (record.hooks.length > 0 || before === 0) kept.push(record);
  }
  if (removed === 0) {
    return { settingsPath, changed: false, removed: 0 };
  }
  if (kept.length > 0) events[event] = kept;
  else delete events[event];
  if (Object.keys(events).length === 0) delete settings.hooks;
  writeSettings(settingsPath, settings);
  return { settingsPath, changed: true, removed };
}

// --------------------------------------------------------------- commands

/** Absolute path of the hook entry point shipped in this repository. */
export function hookCliPath(): string {
  return fileURLToPath(new URL('./cli.ts', import.meta.url));
}

function quote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * The tsx loader as an absolute path.
 *
 * A hook runs with the *project's* cwd, which usually has no tsx installed, so
 * `--import tsx` (a bare specifier) would fail there. Resolving it here, from
 * this repository, makes the installed command independent of where it runs.
 */
function tsxLoader(): string | null {
  try {
    const resolved = createRequire(import.meta.url).resolve('tsx');
    return resolved.endsWith('.mjs') || resolved.endsWith('.js') ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * The shell command to install. `BALLROOM_HOOK=<marker>` is both the marker the
 * installer looks for and a hint to the hook that it runs under a runner.
 *
 * `node --import tsx` is used because the hook is TypeScript in this repository;
 * a published package would use `npx ballroom-hook` instead.
 */
export function hookCommand(options: { cliPath?: string; nodePath?: string; extraArgs?: string[]; marker?: string } = {}): string {
  const marker = options.marker ?? DEFAULT_MARKER;
  const node = options.nodePath ?? process.execPath;
  const cli = options.cliPath ?? hookCliPath();
  const args = (options.extraArgs ?? []).map((arg) => (arg.includes(' ') ? quote(arg) : arg));
  const loader = tsxLoader();
  const importArg = loader ? ['--import', quote(loader)] : ['--import tsx'];
  return [`BALLROOM_HOOK=${marker}`, quote(node), ...importArg, quote(cli), ...args].join(' ');
}
