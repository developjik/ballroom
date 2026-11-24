import { errors } from './errors.js';
import type { EventLog } from './events.js';
import type { Iso } from './util.js';

export interface BreakerLimits {
  /** Messages one agent may post per window (default 10). */
  agentMessagesPerMinute: number;
  /** Messages the whole room may post per window (default 40). */
  roomMessagesPerMinute: number;
  /** Window for the rate limits. */
  rateWindowSeconds: number;
  /** Window in which a loop signature is counted. */
  loopWindowMinutes: number;
  /** How many times one signature may appear before the breaker refuses it. */
  loopSignatureLimit: number;
}

export const DEFAULT_LIMITS: BreakerLimits = {
  agentMessagesPerMinute: 10,
  roomMessagesPerMinute: 40,
  rateWindowSeconds: 60,
  loopWindowMinutes: 10,
  loopSignatureLimit: 3,
};

/**
 * The three breakers of docs/SPEC.md §6.6.
 *
 * 1. per-agent message rate (10 / 60s)
 * 2. per-room message rate (40 / 60s)
 * 3. loop signature: the same (sender, recipient, content, task) may appear
 *    `loopSignatureLimit` times inside `loopWindowMinutes`; the next identical
 *    write is refused with `429 loop_detected`.
 *
 * Rate limits alone cannot stop a loop: two bots alternating every two seconds
 * stay under 60 writes/minute while burning model turns. The signature breaker
 * is what actually stops an echo.
 */
export class Breakers {
  readonly limits: BreakerLimits;

  constructor(
    private readonly log: EventLog,
    limits: Partial<BreakerLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  checkRate(room: string, agent: string, now: Iso): void {
    const since = new Date(Date.parse(now) - this.limits.rateWindowSeconds * 1000).toISOString();
    const roomCount = this.log.countMessagesSince(room, since);
    if (roomCount >= this.limits.roomMessagesPerMinute) {
      throw errors.rateLimited('room', this.limits.rateWindowSeconds);
    }
    const agentCount = this.log.countMessagesSince(room, since, agent);
    if (agentCount >= this.limits.agentMessagesPerMinute) {
      throw errors.rateLimited('agent', this.limits.rateWindowSeconds);
    }
  }

  checkLoop(room: string, signature: string, now: Iso): void {
    const since = new Date(
      Date.parse(now) - this.limits.loopWindowMinutes * 60_000,
    ).toISOString();
    const count = this.log.countSignatureSince(room, signature, since);
    if (count >= this.limits.loopSignatureLimit) {
      throw errors.loopDetected(signature, count);
    }
  }
}
