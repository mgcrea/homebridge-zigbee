/**
 * The reconnect backoff.
 *
 * The jitter matters more than the growth does. Without it, a Homebridge that
 * restarts on a schedule alongside whatever knocked the adapter out retries in
 * lockstep with it forever.
 */
import { describe, expect, it } from "vitest";

import { createBackoff } from "#util/backoff";

describe("createBackoff", () => {
  it("grows the delay and then stops at the ceiling", () => {
    const backoff = createBackoff({ initial: 1_000, max: 8_000, factor: 2 });
    // Equal jitter, so each delay sits in [nominal/2, nominal].
    const bounds = [1_000, 2_000, 4_000, 8_000, 8_000, 8_000];

    for (const nominal of bounds) {
      const delay = backoff.next();
      expect(delay).toBeGreaterThanOrEqual(nominal / 2);
      expect(delay).toBeLessThanOrEqual(nominal);
    }
  });

  it("never returns zero, which would be no backoff at all", () => {
    // This is what "equal jitter" buys over "full jitter": a retry that can
    // land arbitrarily close to zero is no gentler on a coordinator that has
    // just refused to open than not waiting.
    const backoff = createBackoff({ initial: 100, max: 1_000 });
    for (let i = 0; i < 50; i += 1) expect(backoff.next()).toBeGreaterThan(0);
  });

  it("starts over once a connection succeeds", () => {
    const backoff = createBackoff({ initial: 1_000, max: 60_000 });
    for (let i = 0; i < 5; i += 1) backoff.next();
    expect(backoff.attempts).toBe(5);

    backoff.reset();
    expect(backoff.attempts).toBe(0);
    expect(backoff.next()).toBeLessThanOrEqual(1_000);
  });

  it("does not hand out the same delay every time", () => {
    const backoff = createBackoff({ initial: 10_000, max: 10_000 });
    const delays = new Set(Array.from({ length: 20 }, () => backoff.next()));
    expect(delays.size).toBeGreaterThan(1);
  });
});
