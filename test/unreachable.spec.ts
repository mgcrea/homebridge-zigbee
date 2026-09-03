/**
 * What the plugin sends to a device that has stopped answering: nothing.
 *
 * This came out of an overnight log. A garden lamp lost power at its relay at
 * 00:19 and stayed dark until morning, and Adaptive Lighting went on driving
 * its colour temperature once a minute the whole time — six hundred failed
 * sends, each spending a ten-second timeout. Because the adapter runs one
 * transaction at a time, the lamps that *were* reachable queued behind every
 * one of them, and the house felt sluggish until the relay came back.
 *
 * So the rule these specs pin down is: silence is evidence, a refusal is not,
 * and the way back is always open.
 */
import type { PlatformAccessory } from "homebridge";
import type { Models } from "zigbee-herdsman";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LightAccessory } from "#accessories/light-accessory";
import { CLUSTER } from "#model/capability";
import type { DeviceView } from "#model/device";
import { COALESCE_WINDOW_MS } from "#model/queue";
import { StateStore, stateKey } from "#model/state";

import {
  createFakeLog,
  createFakePlatform,
  FakeAccessory,
  FakeEndpoint,
  type FakeLog,
} from "./fake-hap";

const KEY = stateKey("0x00178801020304", 1);

/** Shaped like herdsman's own text, because `isNoAnswer` reads the message. */
const noAnswer = (): Error =>
  new Error(
    "ZCL command 0x00178801020304/1 lightingColorCtrl.moveToColorTemp({}) failed " +
      "(timed out after 10000ms)",
  );

const refusal = (): Error =>
  new Error(
    "ZCL command 0x00178801020304/1 lightingColorCtrl.moveToColorTemp({}) failed " +
      "(Status 'UNSUPPORTED_ATTRIBUTE')",
  );

const view = (): DeviceView => ({
  ieee: "0x00178801020304",
  endpointId: 1,
  key: KEY,
  name: "Garden Lamp",
  manufacturer: "Paulmann Licht GmbH",
  model: "RGBW",
  firmware: "1.0",
  capabilities: new Set(["onOff", "brightness", "colorTemperature"]),
  miredRange: { min: 153, max: 500 },
  isLight: true,
  mainsPowered: true,
});

let state: StateStore;
let endpoint: FakeEndpoint;
let log: FakeLog;
let accessory: FakeAccessory;

const build = (): LightAccessory =>
  new LightAccessory(
    createFakePlatform({ log, state }),
    accessory as unknown as PlatformAccessory,
    view(),
    endpoint as unknown as Models.Endpoint,
  );

const service = (): NonNullable<ReturnType<FakeAccessory["getService"]>> => {
  const found = accessory.getService("Lightbulb");
  if (!found) throw new Error("no Lightbulb service");
  return found;
};

/** Run out the coalescing window and let the queued commands settle. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS + 5);
  await vi.runOnlyPendingTimersAsync();
};

/** One Adaptive Lighting tick: a colour temperature written a minute apart. */
const tick = async (mireds: number): Promise<void> => {
  service().write("ColorTemperature", mireds);
  await settle();
  await vi.advanceTimersByTimeAsync(60_000);
};

beforeEach(() => {
  vi.useFakeTimers();
  state = new StateStore();
  endpoint = new FakeEndpoint();
  log = createFakeLog();
  accessory = new FakeAccessory();
});

describe("a device that has gone silent", () => {
  it("is still sent to while it is answering", async () => {
    build();
    for (const mireds of [200, 210, 220, 230]) await tick(mireds);
    expect(endpoint.attempts).toBe(4);
  });

  it("stops being sent to once it has missed three attempts running", async () => {
    build();
    endpoint.failEvery = noAnswer();

    for (const mireds of [200, 210, 220]) await tick(mireds);
    expect(endpoint.attempts).toBe(3);

    // The fourth tick, and every tick after it, must not reach the radio.
    for (const mireds of [230, 240, 250, 260]) await tick(mireds);
    expect(endpoint.attempts).toBe(3);
  });

  it("says so once, not once per attempt", async () => {
    build();
    endpoint.failEvery = noAnswer();

    for (const mireds of [200, 210, 220, 230, 240, 250]) await tick(mireds);

    const warnings = vi
      .mocked(log.warn)
      .mock.calls.filter((c) => /has not answered/.test(String(c[0])));
    expect(warnings).toHaveLength(1);
  });

  it("puts the tile back where the house is rather than leaving HomeKit optimistic", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: false });
    endpoint.failEvery = noAnswer();

    for (const mireds of [200, 210, 220]) await tick(mireds);

    // HomeKit set On to true itself when the write was accepted; the declined
    // command has to contradict that, because no report is coming to do it.
    service().write("On", true);
    await settle();
    expect(service().getCharacteristic("On").value).toBe(false);
  });
});

describe("coming back", () => {
  it("resumes the moment the device reports of its own accord", async () => {
    build();
    endpoint.failEvery = noAnswer();
    for (const mireds of [200, 210, 220]) await tick(mireds);
    expect(endpoint.attempts).toBe(3);

    endpoint.failEvery = undefined;
    await vi.advanceTimersByTimeAsync(1000);
    state.apply(KEY, CLUSTER.onOff, { onOff: true });

    await tick(230);
    expect(endpoint.attempts).toBe(4);
  });

  it("says so, having said it was gone", async () => {
    build();
    endpoint.failEvery = noAnswer();
    for (const mireds of [200, 210, 220]) await tick(mireds);

    endpoint.failEvery = undefined;
    await vi.advanceTimersByTimeAsync(1000);
    state.apply(KEY, CLUSTER.onOff, { onOff: true });
    await tick(230);

    const said = vi
      .mocked(log.info)
      .mock.calls.map((c) => String(c[0]))
      .join(" ");
    expect(said).toContain("is responding again");
  });
});

describe("a device that answers but says no", () => {
  it("goes on being sent to, because a refusal is not an absence", async () => {
    // Every light here refuses `colorMode` reporting while answering
    // everything else perfectly. Treating that as absence would silence a
    // working lamp.
    build();
    endpoint.failEvery = refusal();

    for (const mireds of [200, 210, 220, 230, 240]) await tick(mireds);

    expect(endpoint.attempts).toBe(5);
    expect(
      vi
        .mocked(log.warn)
        .mock.calls.map((c) => String(c[0]))
        .join(" "),
    ).not.toContain("has not answered");
  });
});
