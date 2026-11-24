/**
 * One contender in the multi-process claim race.
 *   node --import tsx claim-worker.ts <dbFile> <taskId> <agentId> <version> <goAtEpochMs>
 * Prints one JSON line: {ok:true, status} or {ok:false, status, code}.
 */
import { Ballroom } from '../../src/ballroom.js';

const [dbFile, taskId, agentId, version, goAt] = process.argv.slice(2);

async function main(): Promise<void> {
  const target = Number(goAt);
  while (Date.now() < target) {
    // Busy wait: every contender opens the DB first and calls claim at once.
  }
  const b = new Ballroom({ dbFile: dbFile! });
  try {
    const task = b.claim({ owner: 'owner', agent: agentId! }, taskId!, {
      version: Number(version),
      lease_minutes: 5,
    });
    process.stdout.write(JSON.stringify({ ok: true, status: task.status, assignee: task.assignee }));
  } catch (error) {
    const api = error as { status?: number; code?: string };
    process.stdout.write(JSON.stringify({ ok: false, status: api.status, code: api.code }));
  } finally {
    b.close();
  }
}

void main();
