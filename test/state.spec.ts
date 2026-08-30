import { describe, expect, it, vi } from "vitest";

import { type StateChange, StateStore, stateKey } from "#model/state";

const KEY = stateKey("0x0017880102", 1);

describe("StateStore", () => {
  it("reports only what actually changed", () => {
    const store = new StateStore();
    const seen = vi.fn<(change: StateChange) => void>();
    store.subscribe(KEY, seen);

    store.apply(KEY, "genOnOff", { onOff: true });
    store.apply(KEY, "genOnOff", { onOff: true });

    // A mains-powered bulb re-reports on a timer whether or not anything moved.
    // Forwarding those would push a HomeKit update per report.
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("hands subscribers the changed attributes only", () => {
    const store = new StateStore();
    const seen = vi.fn<(change: StateChange) => void>();
    store.apply(KEY, "genLevelCtrl", { currentLevel: 100 });
    store.subscribe(KEY, seen);

    store.apply(KEY, "genLevelCtrl", { currentLevel: 100, remainingTime: 5 });

    expect([...(seen.mock.calls[0]?.[0].changed.keys() ?? [])]).toEqual(["remainingTime"]);
  });

  it("distinguishes 'not heard from' from 'off'", () => {
    const store = new StateStore();
    expect(store.readBoolean(KEY, "genOnOff", "onOff")).toBeUndefined();

    store.apply(KEY, "genOnOff", { onOff: false });
    expect(store.readBoolean(KEY, "genOnOff", "onOff")).toBe(false);
  });

  it("accepts the numeric form of a ZCL boolean", () => {
    const store = new StateStore();
    store.apply(KEY, "genOnOff", { onOff: 1 });
    expect(store.readBoolean(KEY, "genOnOff", "onOff")).toBe(true);
  });

  it("refuses a value whose type does not match what was asked for", () => {
    const store = new StateStore();
    store.apply(KEY, "msTemperatureMeasurement", { measuredValue: "warm" });
    // Trusting a device to honour its own advertised types is how a
    // temperature of "warm" reaches HomeKit.
    expect(store.readNumber(KEY, "msTemperatureMeasurement", "measuredValue")).toBeUndefined();
  });

  it("ignores undefined attributes rather than storing them", () => {
    const store = new StateStore();
    expect(store.apply(KEY, "genOnOff", { onOff: undefined })).toBe(false);
    expect(store.isKnown(KEY)).toBe(true);
    expect(store.readBoolean(KEY, "genOnOff", "onOff")).toBeUndefined();
  });

  it("stops notifying once unsubscribed", () => {
    const store = new StateStore();
    const seen = vi.fn<(change: StateChange) => void>();
    const off = store.subscribe(KEY, seen);

    store.apply(KEY, "genOnOff", { onOff: true });
    off();
    store.apply(KEY, "genOnOff", { onOff: false });

    expect(seen).toHaveBeenCalledTimes(1);
  });
});
