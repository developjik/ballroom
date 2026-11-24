#!/usr/bin/env node
/**
 * Install (or remove) the ballroom pre-tool hook in a project.
 *
 *   npm run hooks:install -- --room-url http://localhost:8787 \
 *       --task task_ab12cd34 --token "$KEY" --agent claude
 *   npm run hooks:remove  -- --dir .
 *
 * What it writes, and nothing else:
 *   <dir>/.claude/settings.local.json   PreToolUse → this repo's hook (merged)
 *   <dir>/.ballroom/gate.json           room URL, task, token for the hook (0600)
 *
 * The token lives in that file because the hook has to send it. Both paths are
 * gitignored by this repository; in another project add `.ballroom/` and
 * `.claude/settings.local.json` to its .gitignore.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  gateFilePathFor,
  hookCliPath,
  hookCommand,
  installGate,
  isInstalled,
  settingsPathFor,
  uninstallGate,
} from '../src/hook/install.js';

const HELP = `install-hooks — attach the ballroom gate to a project

usage: install-hooks [options]
  --dir <path>        project directory (default: cwd)
  --room-url <url>    ballroomd base URL                      (env BALLROOM_ROOM_URL)
  --task <id>         task the session is working on           (env BALLROOM_TASK)
  --token <key>       agent key                                (env BALLROOM_TOKEN)
  --agent <id>        agent id, printed in refusal messages
  --room <name>       room name, for the board link
  --matcher <name>    tool matcher (default Bash)
  --settings <path>   override .claude/settings.local.json
  --command <shell>   override the hook command
  --remove            remove the ballroom hook, keep every other setting
  --print             print the hook command and exit
  --help              this text
`;

function arg(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  const dir = resolve(arg(argv, '--dir') ?? process.cwd());
  const settingsPath = arg(argv, '--settings') ? resolve(arg(argv, '--settings')!) : settingsPathFor(dir);
  const matcher = arg(argv, '--matcher') ?? 'Bash';
  const command = arg(argv, '--command') ?? hookCommand();

  if (argv.includes('--print')) {
    process.stdout.write(`dir:      ${dir}\nsettings: ${settingsPath}\ncommand:  ${command}\n`);
    return;
  }

  if (argv.includes('--remove')) {
    const result = uninstallGate({ dir, settingsPath });
    process.stdout.write(
      result.removed > 0
        ? `removed ${result.removed} ballroom hook(s) from ${result.settingsPath}\n`
        : `no ballroom hook in ${result.settingsPath}; nothing changed\n`,
    );
    process.stdout.write(`the gate file ${gateFilePathFor(dir)} was left in place; delete it if this project is done.\n`);
    return;
  }

  const roomUrl = arg(argv, '--room-url') ?? process.env['BALLROOM_ROOM_URL'] ?? null;
  const task = arg(argv, '--task') ?? process.env['BALLROOM_TASK'] ?? null;
  const token = arg(argv, '--token') ?? process.env['BALLROOM_TOKEN'] ?? null;
  const agent = arg(argv, '--agent') ?? process.env['BALLROOM_AGENT'] ?? null;
  const room = arg(argv, '--room') ?? process.env['BALLROOM_ROOM'] ?? null;

  if (roomUrl && task && token) {
    const result = installGate({
      dir,
      settingsPath,
      matcher,
      command,
      gate: {
        room_url: roomUrl.replace(/\/+$/, ''),
        task,
        token,
        ...(agent ? { agent } : {}),
        ...(room ? { room } : {}),
      },
    });
    process.stdout.write(`${result.changed ? 'installed' : 'already installed'} → ${result.settingsPath}\n`);
    process.stdout.write(`gate file → ${result.gatePath}\n`);
    process.stdout.write(`hook cli  → ${hookCliPath()}\n`);
    return;
  }

  const result = installGate({ dir, settingsPath, matcher, command });
  process.stdout.write(`${result.changed ? 'installed' : 'already installed'} → ${result.settingsPath}\n`);
  process.stdout.write(
    'no room URL / task / token given, so no gate file was written: the hook is installed but not attached to a task yet.\n',
  );
  process.stdout.write(
    `a runner attaches it per task by writing ${gateFilePathFor(dir)} — see "npm run worker".\n`,
  );
  if (!existsSync(settingsPath)) process.stdout.write('(the settings file was created)\n');
  if (!isInstalled(settingsPath)) {
    process.stderr.write('warning: the hook does not look installed after the merge; check the settings file\n');
    process.exitCode = 1;
  }
}

main();
