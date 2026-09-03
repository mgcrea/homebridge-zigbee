import type { PlatformConfig } from "homebridge";
import { describe, expect, it } from "vitest";

import { ConfigError, normalizeIeee, overrideFor, parseConfig } from "#config";

const base = (extra: Record<string, unknown> = {}): PlatformConfig =>
  ({ platform: "Zigbee", port: "/dev/serial/by-id/usb-x", ...extra }) as PlatformConfig;

describe("parseConfig", () => {
  it("refuses to start without a port, and says what to set", () => {
    expect(() => parseConfig({ platform: "Zigbee" } as PlatformConfig)).toThrow(ConfigError);
    expect(() => parseConfig({ platform: "Zigbee" } as PlatformConfig)).toThrow(/serial\/by-id/);
  });

  it("defaults to the zoh adapter and leaves the line settings to herdsman", () => {
    // Defaulting these to a ZBT-2's 460800/rtscts defeated herdsman's own
    // per-adapter detection, which knows a ConBee wants 38400 and a Z-Stack
    // stick 115200 — so those adapters simply failed to open.
    const config = parseConfig(base());
    expect(config.adapter).toBe("zoh");
    expect(config.baudRate).toBeUndefined();
    expect(config.rtscts).toBeUndefined();
  });

  it("still passes line settings through when they are configured", () => {
    const config = parseConfig(base({ baudRate: 115_200, rtscts: false }));
    expect(config.baudRate).toBe(115_200);
    expect(config.rtscts).toBe(false);
  });

  it("rejects an adapter zigbee-herdsman does not have", () => {
    expect(() => parseConfig(base({ adapter: "conbee9000" }))).toThrow(ConfigError);
  });

  it("clamps numbers rather than refusing to start", () => {
    const config = parseConfig(
      base({ channel: 99, refreshInterval: 1, transitionTime: 999, permitJoinDuration: 5_000 }),
    );
    expect(config.channel).toBe(26);
    expect(config.refreshInterval).toBe(30);
    expect(config.transitionTime).toBe(10);
    // ZCL caps permit-join at 254 seconds.
    expect(config.permitJoinDuration).toBe(254);
  });

  it("keeps network reset locked behind an explicit opt-in", () => {
    expect(parseConfig(base()).allowNetworkReset).toBe(false);
    expect(parseConfig(base({ allowNetworkReset: true })).allowNetworkReset).toBe(true);
  });
});

describe("device overrides", () => {
  it("matches an IEEE address however it was typed", () => {
    expect(normalizeIeee("00178801020304")).toBe("0x00178801020304");
    expect(normalizeIeee("0X00178801020304")).toBe("0x00178801020304");
    expect(normalizeIeee("  0x00178801020304  ")).toBe("0x00178801020304");
  });

  it("finds an override written in a different case", () => {
    const config = parseConfig(
      base({ devices: [{ ieee: "0X00178801020304", name: "Desk", exclude: true }] }),
    );
    const override = overrideFor(config, "00178801020304");
    expect(override?.name).toBe("Desk");
    expect(override?.exclude).toBe(true);
  });
});
