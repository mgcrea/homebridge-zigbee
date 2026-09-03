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

  it("says what failed without pasting the whole herdsman error", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });
    endpoint.failWith = new Error(
      'ZCL command 0x001788010cb97916/11 genOnOff.off({}, {"timeout":10000,' +
        '"disableResponse":false,"disableRecovery":false}) failed ' +
        '({"target":30636,"apsFrame":{"profileId":260,"clusterId":6}} timed out after 10000ms)',
    );

    service().write("On", false);
    await settle();

    const warning = String(log.warn.mock.calls.at(-1)?.[0]);
    expect(warning).toContain("genOnOff.off got no answer within 10s");
    expect(warning).not.toContain("apsFrame");
    expect(warning.length).toBeLessThan(120);
  });

  it("puts the Home app back in step with the light", async () => {
    // HomeKit takes the write handler returning as confirmation, so a command
    // the radio never delivered leaves the tile showing a state the lamp is
    // not in — and nothing is coming to correct it.
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });
    state.apply(KEY, CLUSTER.level, { currentLevel: 229 });
    endpoint.failNext = true;

    service().write("On", false);
    await settle();

    expect(service().getCharacteristic("On").value).toBe(true);
    expect(service().getCharacteristic("Brightness").value).toBe(90);
  });

  it("leaves a light it has never heard from alone", async () => {
    // Nothing to put back: pushing a fabricated "off" here is the confident
    // wrong answer the No Response path exists to avoid.
    build();
    endpoint.failNext = true;

    service().write("On", true);
    await settle();

    expect(service().getCharacteristic("On").value).toBeNull();
  });
});

describe("Apple's Adaptive Lighting", () => {
  it("is offered on a light with brightness and colour temperature", () => {
    build();
    // HomeKit accepts it only on a Lightbulb carrying both, which is exactly
    // what the cluster-driven discovery derives.
    expect(accessory.controllers).toHaveLength(1);
  });

  it("is withheld from a light that cannot do colour temperature", () => {
    build(
      colourLightView({ capabilities: new Set(["onOff", "brightness"]), miredRange: undefined }),
    );
    expect(accessory.controllers).toHaveLength(0);
  });

  it("is withheld from a light that cannot dim", () => {
    build(colourLightView({ capabilities: new Set(["onOff", "colorTemperature"]) }));
    expect(accessory.controllers).toHaveLength(0);
  });

  it("can be switched off in config", () => {
    const platform = createFakePlatform({ log, state, config: { adaptiveLighting: false } });
    const light = new LightAccessory(
      platform,
      accessory as unknown as PlatformAccessory,
      colourLightView(),
      endpoint as unknown as Models.Endpoint,
    );

    expect(light.disposed).toBe(false);
    expect(accessory.controllers).toHaveLength(0);
  });

  it("mirrors a colour-temperature write onto hue and saturation without raising an event", () => {
    build();
    const before = service().getCharacteristic("Hue").setHandler;

    service().write("ColorTemperature", 370);

    // updateValue, never setValue: a setValue counts as a HomeKit write and
    // would switch Adaptive Lighting off — which its own 60s schedule would
    // then do to itself.
    expect(service().getCharacteristic("Hue").value).toBe(37);
    expect(service().getCharacteristic("Saturation").value).toBe(42);
    expect(service().getCharacteristic("Hue").setHandler).toBe(before);
  });

  it("parks colour temperature at its minimum when a colour is chosen", () => {
    build(colourLightView({ miredRange: { min: 153, max: 500 } }));
    service().write("Hue", 200);
    expect(service().getCharacteristic("ColorTemperature").value).toBe(153);
  });
});

describe("what a read returns between commanding and being told", () => {
  /**
   * The Home app confirms a write by reading back. Without recording what we
   * just commanded, that read returns the pre-command value and the slider
   * visibly snaps back — 90% to 40% showed 40, then 90, then 40, while the
   * lamp itself sat correctly at 40 throughout.
   */
  it("reads back the brightness just commanded, not the previous one", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });
    state.apply(KEY, CLUSTER.level, { currentLevel: 229 }); // 90%
    expect(service().read("Brightness")).toBe(90);

    service().write("Brightness", 40);
    await settle();

    // The device has reported nothing yet — this is exactly the blink window.
    expect(service().read("Brightness")).toBe(40);
  });

  it("reads back on/off immediately", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });

    service().write("On", false);
    await settle();

    expect(service().read("On")).toBe(false);
  });

  it("reads back a commanded colour temperature, and records the mode with it", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });

    service().write("ColorTemperature", 300);
    await settle();

    expect(service().read("ColorTemperature")).toBe(300);
    // Recording the mode keeps the colorMode guard honest about which colour
    // representation is currently meaningful.
    expect(state.readNumber(KEY, CLUSTER.color, "colorMode")).toBe(2);
  });

  it("records xy and the mode after a colour command", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });

    service().write("Hue", 120);
    service().write("Saturation", 100);
    await settle();

    expect(state.readNumber(KEY, CLUSTER.color, "currentX")).toBeGreaterThan(0);
    expect(state.readNumber(KEY, CLUSTER.color, "colorMode")).toBe(1);
  });

  it("leaves the store honest when the device refuses the command", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });
    state.apply(KEY, CLUSTER.level, { currentLevel: 229 });
    endpoint.failNext = true;

    service().write("Brightness", 40);
    await settle();

    // Nothing was applied, so claiming 40% would be a lie about the hardware.
    expect(state.readNumber(KEY, CLUSTER.level, "currentLevel")).toBe(229);
  });

  it("still lets the device's own report win afterwards", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });

    service().write("Brightness", 40);
    await settle();
    expect(service().read("Brightness")).toBe(40);

    // The light settled somewhere slightly different; it is the authority.
    state.apply(KEY, CLUSTER.level, { currentLevel: 254 });
    expect(service().read("Brightness")).toBe(100);
  });
});

describe("a rediscovery that ran while the light was unreachable", () => {
  /**
   * probeEndpoint cannot read colorCapabilities from a light that does not
   * answer, and correctly declines to guess — so it returns a view with fewer
   * capabilities than the first one. The characteristics are already on the
   * service by then and cannot be removed, so the accessory must not act on
   * the downgrade. Seen in the field as HomeKit rejecting a 140 mired update
   * on a light whose minimum is 153.
   */
  const degraded = colourLightView({
    capabilities: new Set(["onOff", "brightness"]),
    miredRange: undefined,
  });

  it("keeps supplying colour temperature within the advertised bounds", () => {
    const light = build(colourLightView({ miredRange: { min: 153, max: 500 } }));
    light.update(degraded, endpoint as unknown as Models.Endpoint);

    state.apply(KEY, CLUSTER.color, { colorMode: 2, colorTemperature: 100 });

    const supplied = Number(service().getCharacteristic("ColorTemperature").value);
    expect(supplied).toBeGreaterThanOrEqual(153);
    expect(supplied).toBeLessThanOrEqual(500);
  });

  it("never answers a read below the characteristic's minimum", () => {
    const light = build(colourLightView({ miredRange: { min: 153, max: 500 } }));
    light.update(degraded, endpoint as unknown as Models.Endpoint);
    state.apply(KEY, CLUSTER.onOff, { onOff: true });

    expect(Number(service().read("ColorTemperature"))).toBeGreaterThanOrEqual(153);
  });

  it("does not forget capabilities it has already exposed", () => {
    const light = build();
    light.update(degraded, endpoint as unknown as Models.Endpoint);

    state.apply(KEY, CLUSTER.color, { currentX: 20_000, currentY: 30_000 });
    expect(service().getCharacteristic("Hue").value).not.toBeNull();
  });

  it("still takes genuinely new information", () => {
    const light = build(colourLightView({ miredRange: { min: 153, max: 500 } }));
    light.update(
      colourLightView({ name: "Renamed", miredRange: { min: 200, max: 454 } }),
      endpoint as unknown as Models.Endpoint,
    );

    state.apply(KEY, CLUSTER.color, { colorMode: 2, colorTemperature: 300 });
    expect(service().getCharacteristic("ColorTemperature").value).toBe(300);
  });
});

describe("colour temperature asked for while the light is off", () => {
  /**
   * Adaptive Lighting drives colour temperature once a minute whether or not
   * the light is on — hap-nodejs never looks at `On` before calling the SET
   * handler. Every one of those was a radio command into a dark lamp, and on a
   * lamp switched off at a relay it was a ten-second timeout that the whole
   * house queued behind.
   */
  it("sends nothing, but still mirrors so the Home app is right", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: false });

    service().write("ColorTemperature", 370);
    await settle();

    expect(endpoint.commands).toHaveLength(0);
    expect(service().getCharacteristic("Hue").value).toBe(37);
    expect(service().getCharacteristic("Saturation").value).toBe(42);
  });

  it("applies the held value on the way up, before the light comes on", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: false });

    service().write("ColorTemperature", 370);
    await settle();
    service().write("On", true);
    await settle();

    // Colour first: a Hue bulb accepts it while off and applies it on the way
    // up, so the lamp never flashes its previous temperature.
    expect(endpoint.commands.map((c) => c.command)).toEqual(["moveToColorTemp", "on"]);
    expect(endpoint.commands[0]?.payload["colortemp"]).toBe(370);
  });

  it("rides out with a brightness write too", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: false });

    service().write("ColorTemperature", 370);
    await settle();
    service().write("Brightness", 40);
    await settle();

    expect(endpoint.commands.map((c) => c.command)).toEqual([
      "moveToColorTemp",
      "moveToLevelWithOnOff",
    ]);
  });

  it("survives an off in between, because the lamp is still going to come back", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: false });

    service().write("ColorTemperature", 370);
    await settle();
    service().write("On", false);
    await settle();
    service().write("On", true);
    await settle();

    expect(endpoint.commands.map((c) => c.command)).toEqual(["off", "moveToColorTemp", "on"]);
  });

  it("is dropped when a colour is chosen instead", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: false });

    service().write("ColorTemperature", 370);
    await settle();
    service().write("Hue", 200);
    service().write("On", true);
    await settle();

    expect(endpoint.commands.map((c) => c.command)).toEqual(["moveToColor", "on"]);
  });

  it("holds it for a light nothing has ever been heard from", async () => {
    // No evidence it is on, and a fabricated guess here costs a full timeout.
    build();

    service().write("ColorTemperature", 370);
    await settle();

    expect(endpoint.commands).toHaveLength(0);
  });

  it("holds it for a mains light that has gone quiet for hours", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });
    // Past the staleness floor: what the store says about it stopped meaning
    // anything a while ago.
    await vi.advanceTimersByTimeAsync(20 * 60_000);

    service().write("ColorTemperature", 370);
    await settle();

    expect(endpoint.commands).toHaveLength(0);
  });
});

describe("brightness zero", () => {
  it("turns the light off rather than claiming it is on", async () => {
    // moveToLevelWithOnOff at level 0 switches the lamp off. The store used to
    // record `onOff: true` anyway, so Siri's "set the lamp to 0%" left a tile
    // showing a light that was on and dark.
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });
    state.apply(KEY, CLUSTER.level, { currentLevel: 229 });

    service().write("Brightness", 0);
    await settle();

    expect(endpoint.commands[0]?.payload["level"]).toBe(0);
    expect(service().read("On")).toBe(false);
  });

  it("is floored at 1 when the same batch also asked for on", async () => {
    // "On, as dim as it goes" — sending 0 would do the opposite.
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: false });

    service().write("On", true);
    service().write("Brightness", 0);
    await settle();

    expect(endpoint.commands[0]?.payload["level"]).toBe(1);
    expect(service().read("On")).toBe(true);
  });

  it("does not cancel an off that arrived in the same window", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });

    service().write("On", false);
    service().write("Brightness", 80);
    await settle();

    expect(endpoint.commands.map((c) => c.command)).toEqual(["off"]);
  });
});

describe("switching from colour to colour temperature", () => {
  it("does not push the old colour back over the mirror", async () => {
    // `#confirm` records the new colorMode, and the mode moving used to make
    // the state listener recompute Hue and Saturation from the xy pair the
    // lamp held *before* — so a blue lamp set to warm white went briefly blue
    // again in the Home app.
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });
    state.apply(KEY, CLUSTER.color, { colorMode: 1, currentX: 10_000, currentY: 5_000 });

    service().write("ColorTemperature", 370);
    await settle();

    expect(service().getCharacteristic("Hue").value).toBe(37);
    expect(service().getCharacteristic("Saturation").value).toBe(42);
  });

  it("still follows the lamp back to a colour it chose itself", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: true });
    state.apply(KEY, CLUSTER.color, { colorMode: 2, colorTemperature: 370 });
    service().getCharacteristic("Hue").updateValue("sentinel");

    state.apply(KEY, CLUSTER.color, { colorMode: 1, currentX: 20_000, currentY: 30_000 });

    expect(service().getCharacteristic("Hue").value).not.toBe("sentinel");
  });

  it("answers a read with the parked value while the lamp is in xy mode", () => {
    // The lamp goes on answering `colorTemperature` with whatever it held when
    // it was last in colour-temperature mode. Reported straight through, a
    // blue lamp read as cool white.
    build(colourLightView({ miredRange: { min: 153, max: 500 } }));
    state.apply(KEY, CLUSTER.onOff, { onOff: true });
    state.apply(KEY, CLUSTER.color, { colorMode: 1, colorTemperature: 370 });

    expect(service().read("ColorTemperature")).toBe(153);
  });
});

describe("disposal", () => {
  it("gives back the Adaptive Lighting controller", () => {
    // It holds a timer that fires once a minute and a reference to the
    // service, so an accessory unregistered mid-transition went on driving a
    // light the plugin no longer has.
    const light = build();
    expect(accessory.controllers).toHaveLength(1);

    light.dispose();
    expect(accessory.controllers).toHaveLength(0);
  });
});
