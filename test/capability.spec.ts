import { describe, expect, it } from "vitest";

import { capabilitiesFrom, colorSupportFrom, isLight } from "#model/capability";
import { friendlyName } from "#model/device";

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

describe("friendlyName", () => {
  const hue = {
    manufacturerName: "Signify Netherlands B.V.",
    modelID: "440400982842",
    ieeeAddr: "0x0017880102",
  };

  it("prefers the label the device publishes for itself", () => {
    // genBasic.productLabel exists in the ZCL for exactly this purpose.
    expect(friendlyName(hue, 0x010d, "Hue Play")).toBe("Hue Play");
  });

  it("falls back to what people call the vendor, plus the Zigbee device type", () => {
    // Rather than "440400982842", which is a part number.
    expect(friendlyName(hue, 0x010d, undefined)).toBe("Hue Colour Light");
  });

  it("maps the other vendors people actually own", () => {
    expect(
      friendlyName(
        { manufacturerName: "IKEA of Sweden", modelID: "x", ieeeAddr: "0x1" },
        0x0101,
        undefined,
      ),
    ).toBe("IKEA Dimmable Light");
    expect(
      friendlyName({ manufacturerName: "LUMI", modelID: "x", ieeeAddr: "0x1" }, 0x0051, undefined),
    ).toBe("Aqara Smart Plug");
  });

  it("strips the legal suffix from an unrecognised vendor rather than hiding it", () => {
    expect(
      friendlyName(
        { manufacturerName: "Acme Lighting B.V.", modelID: "ZL1", ieeeAddr: "0x1" },
        0x0100,
        undefined,
      ),
    ).toBe("Acme Lighting Light");
  });

  it("keeps the model when the device type is unknown", () => {
    expect(friendlyName(hue, 0x9999, undefined)).toBe("Hue 440400982842");
  });

  it("never returns an empty name", () => {
    expect(
      friendlyName(
        { manufacturerName: undefined, modelID: undefined, ieeeAddr: "0x0017880102" },
        undefined,
        undefined,
      ),
    ).toBe("0x0017880102");
    expect(
      friendlyName(
        { manufacturerName: "  ", modelID: "  ", ieeeAddr: "0x0017880102" },
        undefined,
        "  ",
      ),
    ).toBe("0x0017880102");
  });
});
