/**
 * The plug's whole job is one characteristic, which is exactly why the two
 * things that can go wrong with it are worth pinning down: HomeKit reading
 * back the pre-command value before the plug reports, and HomeKit keeping a
 * value the plug never took.
 */
import type { PlatformAccessory } from "homebridge";
import type { Models } from "zigbee-herdsman";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OutletAccessory } from "#accessories/outlet-accessory";
import { CLUSTER } from "#model/capability";
import type { DeviceView } from "#model/device";
import { COALESCE_WINDOW_MS } from "#model/queue";
import { StateStore } from "#model/state";

import {
  createFakeLog,
  createFakePlatform,
  FakeAccessory,
  FakeEndpoint,
  type FakeLog,
} from "./fake-hap";

const KEY = "0x00178801020304/1";

const plugView = (overrides: Partial<DeviceView> = {}): DeviceView => ({
  ieee: "0x00178801020304",
  endpointId: 1,
  key: KEY,
  name: "Desk Plug",
  manufacturer: "Innr",
  model: "SP 120",
  firmware: "1.0",
  capabilities: new Set(["onOff"]),
  miredRange: undefined,
  isLight: false,
  mainsPowered: true,
  ...overrides,
});

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(COALESCE_WINDOW_MS + 5);
  await vi.runOnlyPendingTimersAsync();
};

let state: StateStore;
let endpoint: FakeEndpoint;
let log: FakeLog;
let accessory: FakeAccessory;

const build = (): OutletAccessory =>
  new OutletAccessory(
    createFakePlatform({ log, state }),
    accessory as unknown as PlatformAccessory,
    plugView(),
    endpoint as unknown as Models.Endpoint,
  );

const service = () => {
  const found = accessory.getService("Outlet");
  if (!found) throw new Error("no Outlet service");
  return found;
};

beforeEach(() => {
  vi.useFakeTimers();
  state = new StateStore();
  endpoint = new FakeEndpoint();
  log = createFakeLog();
  accessory = new FakeAccessory();
});

describe("switching a plug", () => {
  it("sends one command", async () => {
    build();
    service().write("On", true);
    await settle();

    expect(endpoint.commands).toEqual([{ cluster: "genOnOff", command: "on", payload: {} }]);
  });

  it("does not hand back the pre-command value while the report is in flight", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: false });

    service().write("On", true);
    await settle();

    expect(service().read("On")).toBe(true);
  });

  it("leaves the store honest when the plug refuses", async () => {
    build();
    state.apply(KEY, CLUSTER.onOff, { onOff: false });
    endpoint.failNext = true;

    service().write("On", true);
    await settle();

    expect(state.readBoolean(KEY, CLUSTER.onOff, "onOff")).toBe(false);
    expect(service().getCharacteristic("On").value).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("did not switch"));
  });
});
