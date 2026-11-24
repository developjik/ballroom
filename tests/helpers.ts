import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ballroom, type Actor } from '../src/ballroom.js';
import type { BreakerLimits } from '../src/breakers.js';
import { MutableClock } from '../src/clock.js';
import { ApiError } from '../src/errors.js';
import type { Agent, Risk } from '../src/types.js';

export interface AgentOptions {
  kind?: 'cli' | 'hosted' | 'human';
  gate?: 'hook' | 'vendor' | 'none';
  wake?: 'push' | 'poll';
  approval_delegated?: boolean;
  stale_after_min?: number;
  lease_default_min?: number;
  daily_budget_tokens?: number | null;
}

export interface Harness {
  b: Ballroom;
  clock: MutableClock;
  owner: Actor;
  room: string;
  agent: (name: string, options?: AgentOptions) => Actor;
  agentRecord: (name: string) => Agent;
  stop: () => void;
}

export interface HarnessOptions {
  room?: string;
  unattended?: boolean;
  autodispatch?: boolean;
  limits?: Partial<BreakerLimits>;
  start?: string;
  daily_budget_tokens?: number;
}

export function harness(options: HarnessOptions = {}): Harness {
  const clock = new MutableClock(options.start ?? '2026-11-24T09:00:00.000Z');
  const artifactsDir = mkdtempSync(join(tmpdir(), 'ballroom-test-'));
  const b = new Ballroom({ dbFile: ':memory:', clock, artifactsDir });
  const room = options.room ?? 'test';
  b.createRoom({
    room,
    unattended: options.unattended,
    autodispatch: options.autodispatch ?? false,
    daily_budget_tokens: options.daily_budget_tokens ?? 10_000_000,
  });
  if (options.limits) {
    const breakers = b.breakers as unknown as { limits: BreakerLimits };
    breakers.limits = { ...breakers.limits, ...options.limits };
  }
  return {
    b,
    clock,
    owner: { owner: 'owner', agent: null },
    room,
    agent(name: string, agentOptions: AgentOptions = {}): Actor {
      const { agent, confirm_token } = b.signup({
        name,
        kind: agentOptions.kind ?? 'cli',
        room,
        gate: agentOptions.gate ?? 'hook',
        wake: agentOptions.wake ?? 'push',
        approval_delegated: agentOptions.approval_delegated ?? false,
        stale_after_min: agentOptions.stale_after_min ?? 60,
        lease_default_min: agentOptions.lease_default_min ?? 5,
        daily_budget_tokens: agentOptions.daily_budget_tokens ?? null,
      });
      b.confirmAgent(agent.id, confirm_token);
      return { owner: 'owner', agent: agent.id };
    },
    agentRecord(name: string) {
      return b.requireAgent(name);
    },
    stop() {
      b.close();
    },
  };
}

export function taskInput(overrides: Record<string, unknown> = {}) {
  return {
    title: 'task',
    kind: 'cli',
    risk: 'write_local' as Risk,
    check: { kind: 'command' as const, target: 'npm test' },
    ...overrides,
  };
}

export async function expectApiError(
  promise: () => unknown,
  status: number,
  code: string,
): Promise<ApiError> {
  try {
    await promise();
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status !== status || error.code !== code) {
      throw new Error(`expected ${status} ${code}, got ${error.status} ${error.code}: ${error.message}`);
    }
    return error;
  }
  throw new Error(`expected ${status} ${code}, but nothing was thrown`);
}

/** Read everything so the confirm guard is satisfied, and return the cursor. */
export function readAll(h: Harness, actor: Actor, after = 0): number {
  return h.b.inboxOnce(actor, after).cursor;
}
