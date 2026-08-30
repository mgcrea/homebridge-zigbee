import { describe, expect, it } from "vitest";

import { capabilitiesFrom, colorSupportFrom, isLight } from "#model/capability";

/** An endpoint stub that claims exactly the clusters it is given. */
const endpointWith = (...clusters: string[]) => ({
  supportsInputCluster: (cluster: number | string) => clusters.includes(String(cluster)),
});

describe("colorSupportFrom", () => {
  it("reads the ZCL capability bits", () => {
    // bit 0 hue/sat, bit 3 xy, bit 4 colour temperature
    expect(colorSupportFrom(0b1_1001, false)).toEqual({
      hueSaturation: true,
      xy: true,
      colorTemperature: true,
    });
    // A Hue White Ambiance: colour temperature only.
    expect(colorSupportFrom(0b1_0000, false)).toEqual({
      hueSaturation: false,
      xy: false,
      colorTemperature: true,
    });
  });

  it("falls back to the physical bounds when the bits cannot be read", () => {
    expect(colorSupportFrom(undefined, true).colorTemperature).toBe(true);
    expect(colorSupportFrom(undefined, false).colorTemperature).toBe(false);
  });

  it("never guesses colour support upward", () => {
    // A colour wheel on a bulb that cannot do colour is worse than no wheel.
    expect(colorSupportFrom(undefined, true).xy).toBe(false);
    expect(colorSupportFrom(undefined, true).hueSaturation).toBe(false);
  });
});

describe("capabilitiesFrom", () => {
  it("derives a dimmable colour light from its clusters", () => {
    const capabilities = capabilitiesFrom(
      endpointWith("genOnOff", "genLevelCtrl", "lightingColorCtrl"),
      { xy: true, hueSaturation: false, colorTemperature: true },
    );
    expect([...capabilities].toSorted()).toEqual([
      "brightness",
      "color",
      "colorTemperature",
      "onOff",
    ]);
  });

  it("gives a plain relay only on/off", () => {
    const capabilities = capabilitiesFrom(endpointWith("genOnOff"), undefined);
    expect([...capabilities]).toEqual(["onOff"]);
  });

  it("omits colour when the cluster is present but supports neither space", () => {
    const capabilities = capabilitiesFrom(endpointWith("genOnOff", "lightingColorCtrl"), {
      xy: false,
      hueSaturation: false,
      colorTemperature: false,
    });
    expect(capabilities.has("color")).toBe(false);
    expect(capabilities.has("colorTemperature")).toBe(false);
  });
});

describe("isLight", () => {
  it("treats anything dimmable or colour-capable as a light", () => {
    expect(isLight(new Set(["onOff", "brightness"]), undefined)).toBe(true);
    expect(isLight(new Set(["onOff", "colorTemperature"]), undefined)).toBe(true);
  });

  it("uses the Zigbee device id to settle on/off-only devices", () => {
    expect(isLight(new Set(["onOff"]), 0x0100)).toBe(true); // on/off light
    expect(isLight(new Set(["onOff"]), 0x0051)).toBe(false); // smart plug
    expect(isLight(new Set(["onOff"]), undefined)).toBe(false);
  });
});
