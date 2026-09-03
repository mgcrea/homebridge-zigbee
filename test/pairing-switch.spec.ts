/**
 * The switch that opens the network.
 *
 * It is the only control in the plugin with a real side effect on the mesh, and
 * the only one a person presses expecting something to happen right then — so
 * it has to tell the truth about whether it did.
 */
import type { PlatformAccessory } from "homebridge";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PairingSwitch } from "#accessories/pairing-switch";
import type { ZigbeePlatform } from "#platform";

import { createFakeLog, createFakePlatform, FakeAccessory, type FakeLog } from "./fake-hap";

class FakeController {
  permitted: number[] = [];
  failWith: Error | undefined;

  async permitJoin(seconds: number): Promise<void> {
    await Promise.resolve();
    if (this.failWith) throw this.failWith;
    this.permitted.push(seconds);
  }
}

let log: FakeLog;
let accessory: FakeAccessory;
let controller: FakeController;

const build = (withController = true): PairingSwitch => {
  const platform = createFakePlatform({ log });
  if (withController) {
    Object.defineProperty(platform, "controller", { value: controller, configurable: true });
  }
  return new PairingSwitch(
    platform as unknown as ZigbeePlatform,
    accessory as unknown as PlatformAccessory,
  );
};

const service = (): NonNullable<ReturnType<FakeAccessory["getService"]>> => {
  const found = accessory.getService("Switch");
  if (!found) throw new Error("no Switch service");
  return found;
};

beforeEach(() => {
  log = createFakeLog();
  accessory = new FakeAccessory();
  controller = new FakeController();
});

describe("turning it on", () => {
  it("opens the network for the configured window", async () => {
    build();
    await service().write("On", true);

    expect(controller.permitted).toEqual([120]);
    expect(service().getCharacteristic("On").value).toBe(true);
  });

  it("closes it again when switched off", async () => {
    build();
    await service().write("On", true);
    await service().write("On", false);

    expect(controller.permitted).toEqual([120, 0]);
    expect(service().getCharacteristic("On").value).toBe(false);
  });
});

describe("when the network cannot be opened", () => {
  /**
   * The handler used to fire and forget, so hap took the write as having
   * succeeded and the Home app showed the switch on — with the network still
   * shut and nothing about to pair.
   */
  it("reports the failure to HomeKit rather than resolving happily", async () => {
    build();
    controller.failWith = new Error("adapter busy");

    await expect(service().write("On", true)).rejects.toThrow(/HAP -70402/);
    expect(service().getCharacteristic("On").value).toBe(false);
  });

  it("says so when the coordinator is not connected at all", async () => {
    build(false);

    await expect(service().write("On", true)).rejects.toThrow(/HAP -70402/);
    expect(
      vi
        .mocked(log.warn)
        .mock.calls.map((c) => String(c[0]))
        .join(" "),
    ).toContain("not connected");
  });
});

describe("reflecting what the controller actually did", () => {
  it("follows a window opened by something else", () => {
    // `permitJoinChanged` fires for a window opened from a script too, and the
    // switch has to show it rather than its own last position.
    const pairing = build();
    pairing.setOpen(true);
    expect(service().getCharacteristic("On").value).toBe(true);

    pairing.setOpen(false);
    expect(service().getCharacteristic("On").value).toBe(false);
  });
});
