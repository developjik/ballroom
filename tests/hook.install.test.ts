import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_MARKER,
  gateFilePathFor,
  hookCommand,
  installGate,
  isInstalled,
  readSettings,
  settingsPathFor,
  uninstallGate,
} from '../src/hook/install.js';

function project(): string {
  return mkdtempSync(join(tmpdir(), 'ballroom-project-'));
}

describe('installGate — merging into .claude/settings.local.json', () => {
  test('creates the file and the gate config a hook reads', () => {
    const dir = project();
    const result = installGate({
      dir,
      command: 'BALLROOM_HOOK=ballroom-gate node hook.js',
      gate: { room_url: 'http://localhost:8787', task: 'task_1', token: 'br_key' },
    });
    expect(result.changed).toBe(true);
    expect(result.settingsPath).toBe(settingsPathFor(dir));

    const settings = readSettings(settingsPathFor(dir));
    const entries = (settings.hooks as Record<string, { matcher: string; hooks: { command: string }[] }[]>)['PreToolUse'];
    expect(entries).toHaveLength(1);
    expect(entries![0]!.matcher).toBe('Bash');
    expect(entries![0]!.hooks[0]!.command).toContain(DEFAULT_MARKER);

    const gatePath = gateFilePathFor(dir);
    expect(gatePath).toBe(result.gatePath);
    const gate = JSON.parse(readFileSync(gatePath, 'utf8')) as Record<string, string>;
    expect(gate['task']).toBe('task_1');
    expect(gate['token']).toBe('br_key');
    // The token lives in a file only the user can read.
    expect(statSync(gatePath).mode & 0o777).toBe(0o600);
  });

  test('keeps every other setting and hook, and installs once', () => {
    const dir = project();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const original = {
      permissions: { allow: ['Bash(ls)'], deny: ['Read(.env)'] },
      env: { FOO: 'bar' },
      hooks: {
        PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo not-mine' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      },
    };
    writeFileSync(settingsPathFor(dir), JSON.stringify(original, null, 2));

    installGate({ dir, command: 'BALLROOM_HOOK=ballroom-gate node hook.js' });
    const second = installGate({ dir, command: 'BALLROOM_HOOK=ballroom-gate node hook.js' });
    expect(second.changed).toBe(false);

    const settings = readSettings(settingsPathFor(dir)) as typeof original & { hooks: Record<string, unknown[]> };
    expect(settings.permissions).toEqual(original.permissions);
    expect(settings.env).toEqual(original.env);
    expect(settings.hooks['Stop']).toHaveLength(1);
    const pre = settings.hooks['PreToolUse'] as { matcher: string; hooks: { command: string }[] }[];
    expect(pre).toHaveLength(2);
    expect(pre.filter((entry) => entry.matcher === 'Bash')).toHaveLength(1);
    expect(pre.find((entry) => entry.matcher === 'Write')!.hooks[0]!.command).toBe('echo not-mine');
    expect(isInstalled(settingsPathFor(dir))).toBe(true);
  });

  test('uninstall removes only the ballroom hook', () => {
    const dir = project();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      settingsPathFor(dir),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Write', hooks: [{ type: 'command', command: 'echo not-mine' }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'BALLROOM_HOOK=ballroom-gate node hook.js' }] },
          ],
        },
      }),
    );
    const result = uninstallGate({ dir });
    expect(result.removed).toBe(1);
    const settings = readSettings(settingsPathFor(dir)) as { hooks: { PreToolUse: { matcher: string }[] } };
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0]!.matcher).toBe('Write');
    expect(isInstalled(settingsPathFor(dir))).toBe(false);
  });

  test('a file that is not valid JSON is refused and left untouched', () => {
    const dir = project();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const broken = '{ "hooks": { "PreToolUse": [ }';
    writeFileSync(settingsPathFor(dir), broken);
    expect(() => installGate({ dir, command: 'BALLROOM_HOOK=ballroom-gate node hook.js' })).toThrow(/not valid JSON/);
    expect(readFileSync(settingsPathFor(dir), 'utf8')).toBe(broken);
  });

  test('a gate file is only written when the gate values are given', () => {
    const dir = project();
    installGate({ dir, command: 'BALLROOM_HOOK=ballroom-gate node hook.js' });
    expect(existsSync(gateFilePathFor(dir))).toBe(false);
  });

  test('the default hook command carries the marker and an absolute CLI path', () => {
    const command = hookCommand();
    expect(command).toContain(`BALLROOM_HOOK=${DEFAULT_MARKER}`);
    expect(command).toContain('--import');
    // The loader is absolute so the hook still starts in a project without tsx.
    expect(command).toMatch(/--import "[^"]*tsx[^"]*"/);
    expect(command).toMatch(/hook\/cli\.ts"/);
  });
});
