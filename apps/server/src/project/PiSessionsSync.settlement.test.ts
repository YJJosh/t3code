import { expect, it } from "@effect/vitest";
import { settlementTarget } from "./PiSessionsSync.ts";

it.each([
  { imported: true, expected: true },
  { imported: false, expected: false },
])(
  "initial settlement follows terminal only for imported threads ($imported)",
  ({ imported, expected }) => {
    expect(
      settlementTarget({
        baseline: null,
        daemonRev: 3,
        daemonSettled: true,
        t3Settled: false,
        imported,
      }),
    ).toBe(expected);
  },
);
it.each([
  {
    baseline: { daemonRev: 1, daemonSettled: false, t3Settled: false },
    daemonRev: 2,
    daemonSettled: true,
    t3Settled: false,
    expected: true,
  },
  {
    baseline: { daemonRev: 1, daemonSettled: true, t3Settled: true },
    daemonRev: 2,
    daemonSettled: false,
    t3Settled: true,
    expected: false,
  },
  {
    baseline: { daemonRev: 1, daemonSettled: false, t3Settled: false },
    daemonRev: 1,
    daemonSettled: false,
    t3Settled: true,
    expected: true,
  },
  {
    baseline: { daemonRev: 1, daemonSettled: true, t3Settled: true },
    daemonRev: 1,
    daemonSettled: true,
    t3Settled: false,
    expected: false,
  },
  // A daemon settle/unsettle cycle counts as an edit even when the final boolean agrees with its old baseline.
  {
    baseline: { daemonRev: 1, daemonSettled: false, t3Settled: false },
    daemonRev: 3,
    daemonSettled: false,
    t3Settled: true,
    expected: false,
  },
  {
    baseline: { daemonRev: 1, daemonSettled: true, t3Settled: true },
    daemonRev: 3,
    daemonSettled: true,
    t3Settled: false,
    expected: false,
  },
  {
    baseline: { daemonRev: 3, daemonSettled: true, t3Settled: true },
    daemonRev: 2,
    daemonSettled: false,
    t3Settled: false,
    expected: null,
  },
])(
  "reconciles single-sided changes, cycles and stale revisions ($daemonRev/$t3Settled)",
  ({ expected, ...input }) => {
    expect(settlementTarget({ ...input, imported: false })).toBe(expected);
  },
);
