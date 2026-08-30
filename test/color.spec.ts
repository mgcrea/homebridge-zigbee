import { describe, expect, it } from "vitest";

import {
  attributesToXy,
  hueSatToXy,
  kelvinToMired,
  levelToPercent,
  miredToKelvin,
  percentToLevel,
  xyToAttributes,
  xyToHueSat,
} from "#util/color";

describe("hue/saturation <-> xy", () => {
  it("round-trips the primaries closely enough for a colour wheel", () => {
    for (const hue of [0, 60, 120, 180, 240, 300]) {
      const back = xyToHueSat(hueSatToXy({ hue, saturation: 100 }));
      const drift = Math.min(Math.abs(back.hue - hue), 360 - Math.abs(back.hue - hue));
      expect(drift, `hue ${hue} drifted to ${back.hue}`).toBeLessThanOrEqual(5);
      expect(back.saturation).toBeGreaterThan(80);
    }
  });

  it("treats zero saturation as white rather than a hue", () => {
    const { saturation } = xyToHueSat(hueSatToXy({ hue: 210, saturation: 0 }));
    expect(saturation).toBeLessThanOrEqual(5);
  });

  it("never emits NaN, whatever it is handed", () => {
    for (const input of [
      { hue: -50, saturation: 200 },
      { hue: 720, saturation: -1 },
      { hue: 0, saturation: 0 },
    ]) {
      const { x, y } = hueSatToXy(input);
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it("survives an xy pair off the horseshoe without throwing", () => {
    const { hue, saturation } = xyToHueSat({ x: 0.9, y: 0.0 });
    expect(Number.isFinite(hue)).toBe(true);
    expect(Number.isFinite(saturation)).toBe(true);
  });
});

describe("zigbee attribute scaling", () => {
  it("round-trips through the uint16 wire form", () => {
    const xy = hueSatToXy({ hue: 30, saturation: 90 });
    const { colorx, colory } = xyToAttributes(xy);

    expect(Number.isInteger(colorx)).toBe(true);
    expect(colorx).toBeGreaterThanOrEqual(0);
    expect(colorx).toBeLessThanOrEqual(65_535);

    const back = attributesToXy(colorx, colory);
    expect(back.x).toBeCloseTo(xy.x, 3);
    expect(back.y).toBeCloseTo(xy.y, 3);
  });
});

describe("brightness scaling", () => {
  it("maps the ends exactly", () => {
    expect(percentToLevel(0)).toBe(0);
    expect(percentToLevel(100)).toBe(254);
    expect(levelToPercent(0)).toBe(0);
    expect(levelToPercent(254)).toBe(100);
  });

  it("never reports a lit bulb as 0%", () => {
    // A light dimmed to its minimum that reads back as 0% looks switched off in
    // the Home app, which is a different thing entirely.
    expect(levelToPercent(1)).toBe(1);
    expect(levelToPercent(2)).toBeGreaterThanOrEqual(1);
  });

  it("clamps rather than wrapping", () => {
    expect(percentToLevel(-10)).toBe(0);
    expect(percentToLevel(150)).toBe(254);
    expect(levelToPercent(999)).toBe(100);
  });
});

describe("colour temperature units", () => {
  it("round-trips mireds and kelvin", () => {
    expect(miredToKelvin(kelvinToMired(2700))).toBeCloseTo(2700, -1);
    expect(kelvinToMired(miredToKelvin(370))).toBeCloseTo(370, -1);
  });
});
