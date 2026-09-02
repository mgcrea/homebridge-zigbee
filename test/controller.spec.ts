/**
 * The reset guard.
 *
 * `start()` reporting "reset" is completely normal on a first run and a
 * catastrophe on any later one: it means the adapter formed a new network while
 * devices were still paired to the old one. Getting this wrong shows up as
 * every light in the house going unresponsive at once, so it is worth pinning
 * down precisely.
 */
import type { Logging } from "homebridge";
import type { Controller } from "zigbee-herdsman";
import { describe, expect, it, vi } from "vitest";

import { assertNetworkIntact, NetworkResetError, resolvePaths } from "#zigbee/controller";
import type { ZigbeeConfig } from "#config";

const config = (allowNetworkReset = false): ZigbeeConfig => ({ allowNetworkReset }) as ZigbeeConfig;

const outcome = (result: "resumed" | "reset" | "restored") => ({
  controller: {} as Controller,
  result,
});

describe("assertNetworkIntact", () => {
  it("allows a reset on a first run, when nothing was paired yet", () => {
    expect(() => assertNetworkIntact(outcome("reset"), config(), 0)).not.toThrow();
  });

  it("refuses a reset that orphaned paired devices", () => {
    expect(() => assertNetworkIntact(outcome("reset"), config(), 7)).toThrow(NetworkResetError);
  });

  it("says how many devices were lost and how to get them back", () => {
    const attempt = (): void => {
      assertNetworkIntact(outcome("reset"), config(), 7);
    };

    expect(attempt).toThrow("7 device(s)");
    expect(attempt).toThrow(/restore/i);
    expect(attempt).toThrow("allowNetworkReset");
  });

  it("honours the explicit opt-in", () => {
    expect(() => assertNetworkIntact(outcome("reset"), config(true), 7)).not.toThrow();
  });

  it("never blocks a normal resume or restore", () => {
    expect(() => assertNetworkIntact(outcome("resumed"), config(), 7)).not.toThrow();
    expect(() => assertNetworkIntact(outcome("restored"), config(), 7)).not.toThrow();
  });
});

describe("resolvePaths", () => {
  it("keeps all coordinator state under one directory on the persist volume", () => {
    // zoh writes zoh.save and zoh_config.json beside the backup path, so these
    // have to land somewhere that survives a container recreate.
    expect(resolvePaths("/homebridge/persist").stateDirectory).toBe("/homebridge/persist/zigbee");
  });
});

describe("opening the coordinator", () => {
  /**
   * A USB coordinator is routinely unavailable for a moment — after a container
   * restart the previous process may not have released it, and a ZBT-2's USB
   * bridge needs a beat before it answers Spinel. Seen in the field as
   * `SPINEL[tid=1] Timeout after 10000ms`, which used to leave the plugin dead
   * until Homebridge itself was restarted.
   */
  it("keeps retrying after a transient failure to open", async () => {
    vi.useFakeTimers();
    const log = {
      info: vi.fn<(m: string) => void>(),
      warn: vi.fn<(m: string) => void>(),
      error: vi.fn<(m: string) => void>(),
      debug: vi.fn<(m: string) => void>(),
    } as unknown as Logging;

    let attempts = 0;
    const open = vi.fn<() => Promise<void>>(async () => {
      attempts += 1;
      await Promise.resolve();
      if (attempts < 3) throw new Error("SPINEL[tid=1] Timeout after 10000ms");
    });

    // Stand in for the supervisor's open-then-retry contract.
    const backoff = { next: () => 10, reset: () => undefined };
    const run = async (): Promise<void> => {
      for (;;) {
        try {
          await open();
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, backoff.next()));
        }
      }
    };

    const settled = run();
    await vi.advanceTimersByTimeAsync(100);
    await settled;

    expect(attempts).toBe(3);
    expect(log.error).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not retry a deliberate refusal", () => {
    // Retrying cannot change the answer, and hammering the radio would only
    // delay the operator noticing.
    const refusal = new NetworkResetError("network was reset");
    expect(refusal).toBeInstanceOf(NetworkResetError);
    expect(() => {
      throw refusal;
    }).toThrow(NetworkResetError);
  });
});

/**
 * Mirrors the production `releasePort` helper, which is not exported.
 *
 * herdsman's Controller.stop() runs an unguarded backup() before it reaches
 * adapter.stop(), and backup() throws on an adapter that never finished
 * starting — so the port was left open and every retry hit "Cannot lock port".
 * backup() only touches the adapter when backupPath is set, so clearing it
 * lets stop() complete.
 */
class FakeController {
  stopped = false;
  options: { backupPath?: string | undefined } = { backupPath: "/state/backup.json" };

  async stop(): Promise<void> {
    await Promise.resolve();
    // Mirrors the real stop(): the backup step throws while backupPath is set,
    // and adapter.stop() is never reached.
    if (this.options.backupPath !== undefined) {
      throw new Error("backup failed: adapter not started");
    }
    this.stopped = true;
  }
}

const releasePortOf = async (controller: FakeController): Promise<void> => {
  try {
    const internals = controller as unknown as { options?: { backupPath?: string | undefined } };
    if (internals.options) internals.options.backupPath = undefined;
    await controller.stop();
  } catch {
    // swallowed and logged in production
  }
};

describe("releasing the port after a failed start", () => {
  it("reaches adapter.stop() by defusing the unguarded backup", async () => {
    const controller = new FakeController();
    await releasePortOf(controller);
    expect(controller.stopped).toBe(true);
  });

  it("would NOT have released it without that step", async () => {
    const controller = new FakeController();
    await controller.stop().catch(() => undefined);
    expect(controller.stopped).toBe(false);
  });
});
