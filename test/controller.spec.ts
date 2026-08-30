/**
 * The reset guard.
 *
 * `start()` reporting "reset" is completely normal on a first run and a
 * catastrophe on any later one: it means the adapter formed a new network while
 * devices were still paired to the old one. Getting this wrong shows up as
 * every light in the house going unresponsive at once, so it is worth pinning
 * down precisely.
 */
import type { Controller } from "zigbee-herdsman";
import { describe, expect, it } from "vitest";

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
