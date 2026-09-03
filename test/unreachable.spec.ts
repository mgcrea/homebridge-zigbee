/**
 * What the plugin sends to a device that has stopped answering.
 *
 * This came out of an overnight log. A garden lamp lost power at its relay at
 * 00:19 and stayed dark until morning, and Adaptive Lighting went on driving
 * its colour temperature once a minute the whole time — six hundred failed
 * sends, each spending a ten-second timeout. Because the adapter runs one
 * transaction at a time, the lamps that *were* reachable queued behind every
 * one of them, and the house felt sluggish until the relay came back.
 *
 * So the rule these specs pin down is: silence is evidence, a refusal is not,
 * and the way back is always open. The last part is what separates the two
 * kinds of write. The schedule's writes are dropped, because the schedule will
 * be back in sixty seconds anyway. A person's tap is not, because it is the
 * best probe there is — and the whole point of the outage detection is to stop
 * the house feeling slow, not to make the one lamp the user is standing in
 * front of unresponsive until the next poll.
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

/**
 * The context hap-nodejs puts on the writes Adaptive Lighting makes on its own
 * schedule. Its presence is the only thing that distinguishes them from a tap.
 */
const SCHEDULED = { controller: {}, omitEventUpdate: true };

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

/**
 * A lamp HomeKit believes is on.
 *
 * Colour temperature is only ever sent to a light that will be lit — a value
 * asked for while it is off is held back rather than spent on the radio — so
 * every outage scenario here starts from a light that is on.
 */
const build = (): LightAccessory => {
  state.apply(KEY, CLUSTER.onOff, { onOff: true });
  return new LightAccessory(
    createFakePlatform({ log, state }),
    accessory as unknown as PlatformAccessory,
    view(),
    endpoint as unknown as Models.Endpoint,
  );
};

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
  service().write("ColorTemperature", mireds, SCHEDULED);
  await settle();
  await vi.advanceTimersByTimeAsync(60_000);
};

/** A person pressing the tile. No context, so nothing marks it automated. */
const tap = async (on: boolean): Promise<void> => {
  service().write("On", on);
  await settle();
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

  it("stops being driven by the schedule once it has missed three attempts running", async () => {
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

  it("puts the tile back where the house is when it declines the schedule", async () => {
    build();
    endpoint.failEvery = noAnswer();
    for (const mireds of [200, 210, 220]) await tick(mireds);

    // Stand in for HomeKit's optimism: it moves the characteristic the instant
    // a write is accepted, and a declined write leaves nothing to contradict it.
    service().getCharacteristic("On").updateValue(false);

    await tick(230);
    expect(service().getCharacteristic("On").value).toBe(true);
  });

  it("contradicts a tap that never reached the lamp", async () => {
    build();
    endpoint.failEvery = noAnswer();

    await tap(false);
    expect(service().getCharacteristic("On").value).toBe(true);
  });
});

describe("a tap on a lamp that has gone quiet", () => {
  it("still reaches the radio, because the tap is the probe", async () => {
    build();
    endpoint.failEvery = noAnswer();
    for (const mireds of [200, 210, 220]) await tick(mireds);
    expect(endpoint.attempts).toBe(3);

    await tap(true);
    expect(endpoint.attempts).toBe(4);
  });

  it("ends the outage the moment it succeeds, without waiting for a poll", async () => {
    build();
    endpoint.failEvery = noAnswer();
    for (const mireds of [200, 210, 220]) await tick(mireds);

    // The relay came back. Nothing has been heard from the lamp yet — only the
    // tap will find that out.
    endpoint.failEvery = undefined;
    await tap(true);

    expect(endpoint.commands.at(-1)).toMatchObject({ cluster: "genOnOff", command: "on" });
    expect(
      vi
        .mocked(log.info)
        .mock.calls.map((c) => String(c[0]))
        .join(" "),
    ).toContain("is responding again");

    // And the schedule is welcome again straight away.
    await tick(230);
    expect(endpoint.attempts).toBe(5);
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
    state.apply(KEY, CLUSTER.onOff, { onOff: false });
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
    state.apply(KEY, CLUSTER.onOff, { onOff: false });
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

/** One turn of the platform's periodic refresh, for one accessory. */
const cycle = async (light: LightAccessory): Promise<void> => {
  await light.refreshFromRadio();
  await vi.runOnlyPendingTimersAsync();
};

describe("polling a device that is not answering", () => {
  /**
   * The commit that introduced the outage guard argued for polling every cycle
   * regardless, on the grounds that it is the only way back. That is right and
   * it is also expensive: each probe is a ten-second timeout on a radio that
   * runs one transaction at a time, so with three dead lamps a fifth of the
   * radio goes on rediscovering the same absence. The gap doubles instead, and
   * a tap on the tile remains the fast way back.
   */
  it("backs off to every second, fourth and eighth cycle while the silence lasts", async () => {
    const light = build();
    endpoint.readFails = true;

    // Three unanswered reads is what makes it unreachable in the first place.
    for (let i = 0; i < 3; i += 1) await cycle(light);
    const probesBefore = endpoint.reads.length;

    // Fifteen further cycles: probes land on the 1st, then after 1, 2, 4 and 8
    // skipped ones.
    for (let i = 0; i < 15; i += 1) await cycle(light);

    expect(endpoint.reads.length - probesBefore).toBe(4);
  });

  it("goes straight back to every cycle once the device is heard again", async () => {
    const light = build();
    endpoint.readFails = true;
    for (let i = 0; i < 6; i += 1) await cycle(light);

    endpoint.readFails = false;
    state.apply(KEY, CLUSTER.onOff, { onOff: false });
    const probesBefore = endpoint.reads.length;

    for (let i = 0; i < 3; i += 1) await cycle(light);
    expect(endpoint.reads.length - probesBefore).toBe(3);
  });
});
