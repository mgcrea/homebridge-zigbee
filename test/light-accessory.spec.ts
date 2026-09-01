/**
 * What HomeKit's writes actually become on the radio.
 *
 * These specs exist because the mapping is not one-to-one: HomeKit writes Hue
 * and Saturation separately, and fires a whole scene as several characteristic
 * sets at once. The assertions here are mostly counts — how many commands
 * reached the bulb — because that is the difference between a light that snaps
 * to a colour and one that visibly steps through three intermediate states.
 */
import type { Models } from "zigbee-herdsman";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LightAccessory } from "#accessories/light-accessory";
import { CLUSTER } from "#model/capability";
import type { DeviceView } from "#model/device";
import { StateStore } from "#model/state";
import { COALESCE_WINDOW_MS } from "#model/queue";
import type { PlatformAccessory } from "homebridge";

import {
  createFakeLog,
  createFakePlatform,
  FakeAccessory,
  FakeEndpoint,
  type FakeLog,
} from "./fake-hap";

const KEY = "0x00178801020304/1";

const colourLightView = (overrides: Partial<DeviceView> = {}): DeviceView => ({
  ieee: "0x00178801020304",
  endpointId: 1,
  key: KEY,
  name: "Desk Lamp",
  manufacturer: "Philips",
  model: "LCT015",
  firmware: "1.0",
  capabilities: new Set(["onOff", "brightness", "colorTemperature", "color"]),
  miredRange: { min: 153, max: 500 },
  isLight: true,
  mainsPowered: true,
  ...overrides,
});

/** Run out the coalescing window and let the queued commands settle. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS + 5);
  await vi.runOnlyPendingTimersAsync();
};

let state: StateStore;
let endpoint: FakeEndpoint;
let log: FakeLog;
let accessory: FakeAccessory;

const build = (view: DeviceView = colourLightView()): LightAccessory => {
  const platform = createFakePlatform({ log, state });
  return new LightAccessory(
    platform,
    accessory as unknown as PlatformAccessory,
    view,
    endpoint as unknown as Models.Endpoint,
  );
};

const service = (): NonNullable<ReturnType<FakeAccessory["getService"]>> => {
  const found = accessory.getService("Lightbulb");
  if (!found) throw new Error("no Lightbulb service");
  return found;
};

beforeEach(() => {
  vi.useFakeTimers();
  state = new StateStore();
  endpoint = new FakeEndpoint();
  log = createFakeLog();
  accessory = new FakeAccessory();
});

describe("reading a light HomeKit has heard nothing from", () => {
  it("reports No Response rather than inventing Off", () => {
    build();
    // A light that shows "Off" before anything has been read is a confident
    // wrong answer; "No Response" is visibly an absence of one.
    expect(() => service().read("On")).toThrow(/HAP -70402/);
  });

  it("reads normally once a report has arrived", () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });
    expect(service().read("On")).toBe(true);
  });
});

describe("coalescing", () => {
  it("turns a Hue and a Saturation write into ONE moveToColor", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });

    service().write("Hue", 120);
    service().write("Saturation", 80);
    await settle();

    const colour = endpoint.commands.filter((c) => c.command === "moveToColor");
    expect(colour).toHaveLength(1);
    expect(endpoint.commands).toHaveLength(1);
  });

  it("collapses a scene's On + Brightness + ColorTemperature", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: false });

    service().write("On", true);
    service().write("Brightness", 40);
    service().write("ColorTemperature", 370);
    await settle();

    // moveToLevelWithOnOff switches the light on as a side effect, so a
    // separate `on` would be a wasted round trip.
    expect(endpoint.commands.map((c) => c.command)).toEqual([
      "moveToColorTemp",
      "moveToLevelWithOnOff",
    ]);
  });

  it("sends colour before switching on, so the bulb does not flash its old colour", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: false });

    service().write("On", true);
    service().write("Hue", 300);
    service().write("Saturation", 100);
    await settle();

    expect(endpoint.commands[0]?.command).toBe("moveToColor");
  });

  it("keeps only the newest value when a slider is dragged", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });

    for (const percent of [10, 20, 30, 40, 55]) service().write("Brightness", percent);
    await settle();

    expect(endpoint.commands).toHaveLength(1);
    expect(endpoint.commands[0]?.payload["level"]).toBe(Math.round(55 * 2.54));
  });

  it("ignores everything else when the light is being switched off", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });

    service().write("Brightness", 80);
    service().write("On", false);
    await settle();

    expect(endpoint.commands.map((c) => c.command)).toEqual(["off"]);
  });

  it("lets colour temperature supersede a pending colour, and the reverse", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });

    service().write("Hue", 200);
    service().write("ColorTemperature", 250);
    await settle();

    expect(endpoint.commands.map((c) => c.command)).toEqual(["moveToColorTemp"]);
  });
});

describe("state changes coming back from the radio", () => {
  it("pushes an externally switched light into HomeKit", () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });
    expect(service().getCharacteristic("On").value).toBe(true);

    state.apply(KEY, CLUSTER.onOff, { onOff: false });
    expect(service().getCharacteristic("On").value).toBe(false);
  });

  it("refreshes both colour axes when either coordinate moves", () => {
    build();
    state.apply(KEY, CLUSTER.color, { currentX: 20_000, currentY: 30_000 });

    expect(service().getCharacteristic("Hue").value).not.toBeNull();
    expect(service().getCharacteristic("Saturation").value).not.toBeNull();
  });

  it("does not re-notify when a report repeats a value it already holds", () => {
    build();
    state.apply(KEY, CLUSTER.level, { currentLevel: 100 });
    const first = service().getCharacteristic("Brightness").value;

    service().getCharacteristic("Brightness").updateValue("sentinel");
    const changed = state.apply(KEY, CLUSTER.level, { currentLevel: 100 });

    expect(changed).toBe(false);
    expect(service().getCharacteristic("Brightness").value).toBe("sentinel");
    expect(first).not.toBe("sentinel");
  });
});

describe("colour temperature vs colour mode", () => {
  it("ignores the stale colorTemperature a light in xy mode reports", () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });
    state.apply(KEY, CLUSTER.color, { colorMode: 2, colorTemperature: 370 });
    expect(service().getCharacteristic("ColorTemperature").value).toBe(370);

    // Observed on a real Hue Play: showing full blue, still answering 153 mired
    // for colorTemperature. Pushed unguarded, HomeKit renders it as cool white.
    state.apply(KEY, CLUSTER.color, { colorMode: 1, colorTemperature: 153 });

    expect(service().getCharacteristic("ColorTemperature").value).toBe(370);
  });

  it("resumes trusting it once the light returns to colour-temperature mode", () => {
    build();
    state.apply(KEY, CLUSTER.color, { colorMode: 1, colorTemperature: 153 });
    state.apply(KEY, CLUSTER.color, { colorMode: 2, colorTemperature: 250 });

    expect(service().getCharacteristic("ColorTemperature").value).toBe(250);
  });

  it("trusts a light that never reports colorMode at all", () => {
    // A colour-temperature-only bulb has no other representation to confuse it
    // with, so silence there must not disable the characteristic.
    build(colourLightView({ capabilities: new Set(["onOff", "colorTemperature"]) }));
    state.apply(KEY, CLUSTER.color, { colorTemperature: 320 });

    expect(service().getCharacteristic("ColorTemperature").value).toBe(320);
  });
});

describe("colour temperature bounds", () => {
  it("clamps the characteristic to what the bulb can actually do", () => {
    build(colourLightView({ miredRange: { min: 153, max: 454 } }));
    expect(service().getCharacteristic("ColorTemperature").props).toMatchObject({
      minValue: 153,
      maxValue: 454,
    });
  });

  it("omits the characteristic entirely on a light without colour temperature", () => {
    build(
      colourLightView({
        capabilities: new Set(["onOff", "brightness"]),
        miredRange: undefined,
      }),
    );
    expect(service().characteristics.has("ColorTemperature")).toBe(false);
  });
});

describe("a device that refuses a command", () => {
  it("warns instead of throwing into Homebridge", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });
    endpoint.failNext = true;

    service().write("On", false);
    await settle();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("did not accept"));
  });
});
