import { describe, expect, test } from 'vitest';
import { runSimulation } from '../src/sim/phase0.js';

/**
 * The simulation is the readable artifact (docs/PHASE0.md); this keeps it
 * honest. Every observation it prints must still hold.
 */
describe('Phase 0 simulation', () => {
  test('every observation passes', async () => {
    const rows = await runSimulation();
    expect(rows.length).toBeGreaterThanOrEqual(12);
    const failed = rows.filter((row) => !row.ok).map((row) => `${row.question} → ${row.observed}`);
    expect(failed).toEqual([]);
  }, 60_000);
});
