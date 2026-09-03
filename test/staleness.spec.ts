/**
 * A device that has gone quiet must read as unreachable, not as whatever it
 * last said.
 *
 * Both lights sat silent for twelve hours while HomeKit confidently showed the
 * previous day's brightness, and the only way to find out was to read the
 * coordinator's logs. That is the same class of bug as answering before a
 * device has ever been heard from — a confident wrong answer about the house
 * rather than a visible absence of one.
 */
import type { PlatformAccessory } from "homebridge";
import type { Models } from "zigbee-herdsman";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LightAccessory } from "#accessories/light-accessory";
import { CLUSTER } from "#model/capability";
import type { DeviceView } from "#model/device";
import { StateStore, stateKey } from "#model/state";

import { createFakeLog, createFakePlatform, FakeAccessory, FakeEndpoint } from "./fake-hap";

const KEY = stateKey("0x00178801020304", 1);

const view = (overrides: Partial<DeviceView> = {}): DeviceView => ({
  ieee: "0x00178801020304",
  endpointId: 1,
  key: KEY,
  name: "Desk Lamp",
  manufacturer: "Philips",
  model: "LCT015",
  firmware: "1.0",
  capabilities: new Set(["onOff", "brightness"]),
  miredRange: undefined,
  isLight: true,
  mainsPowered: true,
  ...overrides,
});

let state: StateStore;
let accessory: FakeAccessory;

const build = (v: DeviceView = view()): void => {
  const platform = createFakePlatform({ log: createFakeLog(), state });
  const endpoint = new FakeEndpoint() as unknown as Models.Endpoint;
  new LightAccessory(platform, accessory as unknown as PlatformAccessory, v, endpoint).update(
    v,
    endpoint,
  );
};

const service = () => {
  const found = accessory.getService("Lightbulb");
  if (!found) throw new Error("no Lightbulb service");
  return found;
};

beforeEach(() => {
  vi.useFakeTimers();
  state = new StateStore();
  accessory = new FakeAccessory();
});

describe("a mains device that has gone quiet", () => {
  it("answers normally while it is being heard", () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });
    expect(service().read("On")).toBe(true);
  });

  it("reads as No Response once it has been silent too long", () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });

    // Default refresh is 300s, so the threshold is 15 minutes.
    vi.advanceTimersByTime(20 * 60 * 1000);

    expect(() => service().read("On")).toThrow(/HAP -70402/);
  });

  it("recovers as soon as the device speaks again", () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });
    vi.advanceTimersByTime(20 * 60 * 1000);
    expect(() => service().read("On")).toThrow(/HAP -70402/);

    state.apply(KEY, CLUSTER.onOff, { onOff: true });
    expect(service().read("On")).toBe(true);
  });

  it("counts a repeated identical report as being heard from", () => {
    // A light reporting the same brightness every minute changes nothing, but
    // it is plainly alive. Tracking liveness by "when did a value last move"
    // would call it stale.
    build();
    state.apply(KEY, CLUSTER.level, { currentLevel: 100 });
    state.apply(KEY, CLUSTER.onOff, { onOff: true });

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(state.apply(KEY, CLUSTER.level, { currentLevel: 100 })).toBe(false);

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(service().read("On")).toBe(true);
  });
});

describe("a battery device", () => {
  it("is never called stale, because it sleeps by design", () => {
    // Battery devices are deliberately never polled, so silence says nothing
    // about them.
    build(view({ mainsPowered: false }));
    state.apply(KEY, CLUSTER.onOff, { onOff: true });

    vi.advanceTimersByTime(6 * 60 * 60 * 1000);

    expect(service().read("On")).toBe(true);
  });
});
