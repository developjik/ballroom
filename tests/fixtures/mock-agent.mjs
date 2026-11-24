#!/usr/bin/env node
/**
 * A stand-in for a coding agent CLI, for tests and for the mac verify script.
 *
 * It behaves like a real one in the only way that matters to ballroom: it does
 * not run a risky command itself, it asks the project's pre-tool hook first and
 * obeys the hook's exit code.
 *
 *   0  → the hook allowed it: "run" the command and write out/evidence.md
 *   2  → the hook refused: print the hook's stderr, write out/blocked.log, end
 *        the turn normally (that is what a model does when its tool call is
 *        blocked: it stops and reports)
 *
 *   node tests/fixtures/mock-agent.mjs --prompt "task …" [--resume <session>]
 *        [--push "git push --force origin main"] [--fail]
 *
 * Exit codes: 0 turn finished · 3 the `--fail` crash path.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : true;
};

const prompt = String(flag('--prompt', '(no prompt)'));
const resume = flag('--resume');
const push = String(flag('--push', 'git push --force origin main'));
const crash = argv.includes('--fail');
const gateWaitMs = Number(flag('--gate-wait', 2000));
const cwd = process.cwd();
const hookCli = process.env.BALLROOM_HOOK_CLI ?? fileURLToPath(new URL('../../src/hook/cli.ts', import.meta.url));
// The hook is TypeScript; load it with the tsx loader from this repository, not
// from the project directory the agent runs in.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const tsxLoader = join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const tsxArgs = existsSync(tsxLoader) ? ['--import', tsxLoader] : ['--import', 'tsx'];

const say = (line) => process.stdout.write(`${line}\n`);
say(`[mock-agent] turn start${resume ? ` (resume ${resume})` : ''}`);
say(`[mock-agent] prompt: ${prompt.split('\n')[0]}`);

if (crash) {
  process.stderr.write('[mock-agent] simulated crash before the turn\n');
  process.exit(3);
}

/** The gate file the runner writes; a real CLI would not read it, but its hook would. */
function gate() {
  const path = join(cwd, '.ballroom', 'gate.json');
  const attempts = Math.max(1, Math.ceil(gateWaitMs / 40));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return null;
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  }
  return null;
}

const gateFile = gate();
const env = {
  ...process.env,
  ...(gateFile?.room_url ? { BALLROOM_ROOM_URL: gateFile.room_url } : {}),
  ...(gateFile?.token ? { BALLROOM_TOKEN: gateFile.token } : {}),
  ...(gateFile?.task ? { BALLROOM_TASK: gateFile.task } : {}),
  BALLROOM_HOOK_CLI: hookCli,
};

const payload = JSON.stringify({
  session_id: resume ?? 'mock-session',
  cwd,
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: push, description: 'ship the work' },
});

const hook = spawnSync(process.execPath, [...tsxArgs, hookCli], {
  input: payload,
  env,
  cwd: repoRoot,
  encoding: 'utf8',
});

const code = hook.status ?? 1;
if (code === 2) {
  const reason = (hook.stderr ?? '').trim();
  say(`[mock-agent] the hook blocked "${push}":`);
  say(reason);
  mkdirSync(join(cwd, 'out'), { recursive: true });
  writeFileSync(join(cwd, 'out', 'blocked.log'), `${push}\n\n${reason}\n`);
  say('[mock-agent] ending the turn; the approval is the owner’s to give');
  process.exit(0);
}

if (code !== 0) {
  say(`[mock-agent] the hook failed with code ${code}; refusing to run "${push}"`);
  say((hook.stderr ?? '').trim());
  process.exit(0);
}

say(`[mock-agent] the hook allowed "${push}"; running it`);
mkdirSync(join(cwd, 'out'), { recursive: true });
writeFileSync(join(cwd, 'out', 'push.log'), `${new Date().toISOString()} pushed (simulated)\n`);
writeFileSync(
  join(cwd, 'out', 'evidence.md'),
  [
    '# evidence',
    '',
    `- command: ${push}`,
    `- turn: ${resume ? `resume ${resume}` : 'first'}`,
    `- gate: allowed by the room`,
    `- at: ${new Date().toISOString()}`,
    '',
    'The pre-tool hook approved this once; the grant was single use.',
    '',
  ].join('\n'),
);
say('[mock-agent] done');
process.exit(0);
