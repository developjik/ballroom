/**
 * Time is injected everywhere so the keeper, leases, approvals and budgets can
 * be replayed deterministically (`--sim` and the conformance tests use it).
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * A clock the caller can move by hand. Used by tests and by the Phase 0
 * simulation (24h a jump at a time).
 */
export class MutableClock implements Clock {
  private current: Date;

  constructor(iso: string = '2026-01-01T00:00:00.000Z') {
    this.current = new Date(iso);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(iso: string): void {
    this.current = new Date(iso);
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  advanceMinutes(minutes: number): void {
    this.advanceMs(minutes * 60_000);
  }

  advanceHours(hours: number): void {
    this.advanceMinutes(hours * 60);
  }
}
