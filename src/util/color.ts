/**
 * Colour conversions between what HomeKit speaks and what a Zigbee light does.
 *
 * HomeKit thinks in HSV (Hue 0-360°, Saturation 0-100%) and in mireds for
 * colour temperature. Zigbee's `lightingColorCtrl` reports colour as a CIE 1931
 * xy chromaticity pair, and its `colorTemperature` attribute is *already* in
 * mireds — so that half needs no conversion at all, only clamping.
 *
 * The xy half is done through the Wide Gamut RGB D65 matrices that Philips
 * publishes for Hue. Reading back `enhancedCurrentHue`/`currentSaturation`
 * instead would be simpler, but Hue bulbs keep those attributes stale once the
 * light has been driven by xy, so xy is treated as the source of truth.
 */

/** Zigbee reports xy as uint16 fractions of this. */
const XY_SCALE = 65_535;

export type XY = { x: number; y: number };
export type HueSat = { hue: number; saturation: number };

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/** Linear light to companded sRGB. */
const compand = (value: number): number =>
  value <= 0.003_130_8 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;

/** Companded sRGB back to linear light. */
const uncompand = (value: number): number =>
  value > 0.040_45 ? ((value + 0.055) / 1.055) ** 2.4 : value / 12.92;

/**
 * HomeKit hue/saturation to the CIE xy pair a `moveToColor` command wants.
 *
 * Brightness is deliberately not part of this: HomeKit carries it on a separate
 * characteristic and Zigbee carries it on a separate cluster, so folding it in
 * here would mean two places fighting over the same value.
 */
export const hueSatToXy = ({ hue, saturation }: HueSat): XY => {
  const [red, green, blue] = hsvToRgb(clamp(hue, 0, 360), clamp(saturation, 0, 100) / 100);

  const r = uncompand(red);
  const g = uncompand(green);
  const b = uncompand(blue);

  const bigX = r * 0.664_511 + g * 0.154_324 + b * 0.162_028;
  const bigY = r * 0.283_881 + g * 0.668_433 + b * 0.047_685;
  const bigZ = r * 0.000_088 + g * 0.072_310 + b * 0.986_039;

  const sum = bigX + bigY + bigZ;
  // Pure black has no chromaticity. Any answer here is arbitrary, so pick D65
  // white rather than emitting NaN into a radio command.
  if (sum === 0) return { x: 0.312_7, y: 0.329_0 };

  return { x: bigX / sum, y: bigY / sum };
};

/** The CIE xy pair a light reports, as the hue/saturation HomeKit shows. */
export const xyToHueSat = ({ x, y }: XY): HueSat => {
  // y === 0 is off the horseshoe entirely; treat it as white rather than
  // dividing by zero.
  if (y === 0) return { hue: 0, saturation: 0 };

  const bigY = 1;
  const bigX = (bigY / y) * x;
  const bigZ = (bigY / y) * (1 - x - y);

  const r = compand(bigX * 1.656_492 - bigY * 0.354_851 - bigZ * 0.255_038);
  const g = compand(-bigX * 0.707_196 + bigY * 1.655_397 + bigZ * 0.036_152);
  const b = compand(bigX * 0.051_713 - bigY * 0.121_364 + bigZ * 1.011_530);

  // The matrix can leave the sRGB cube on saturated colours. Scaling by the
  // largest component keeps the hue and pulls it back in, where clipping each
  // channel independently would shift it.
  const peak = Math.max(r, g, b);
  const scale = peak > 1 ? 1 / peak : 1;

  return rgbToHueSat(clamp(r * scale, 0, 1), clamp(g * scale, 0, 1), clamp(b * scale, 0, 1));
};

/** Zigbee's uint16 xy attributes as fractions. */
export const attributesToXy = (currentX: number, currentY: number): XY => ({
  x: clamp(currentX / XY_SCALE, 0, 1),
  y: clamp(currentY / XY_SCALE, 0, 1),
});

/** Fractions back to the uint16 pair `moveToColor` expects. */
export const xyToAttributes = ({ x, y }: XY): { colorx: number; colory: number } => ({
  colorx: Math.round(clamp(x, 0, 1) * XY_SCALE),
  colory: Math.round(clamp(y, 0, 1) * XY_SCALE),
});

export const miredToKelvin = (mired: number): number => Math.round(1_000_000 / mired);
export const kelvinToMired = (kelvin: number): number => Math.round(1_000_000 / kelvin);

/** HomeKit's 0-100 brightness as Zigbee's 0-254 level. */
export const percentToLevel = (percent: number): number =>
  Math.round(clamp(percent, 0, 100) * 2.54);

/**
 * Zigbee's 0-254 level as HomeKit's 0-100 brightness.
 *
 * Any non-zero level rounds up to at least 1%. A dimmed-to-minimum bulb that
 * reports 0% reads in the Home app as off, which it is not.
 */
export const levelToPercent = (level: number): number => {
  const bounded = clamp(level, 0, 254);
  if (bounded === 0) return 0;
  return Math.max(1, Math.round(bounded / 2.54));
};

const hsvToRgb = (hue: number, saturation: number): [number, number, number] => {
  const sector = hue / 60;
  const chroma = saturation;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));

  const [r, g, b] =
    sector < 1
      ? [chroma, second, 0]
      : sector < 2
        ? [second, chroma, 0]
        : sector < 3
          ? [0, chroma, second]
          : sector < 4
            ? [0, second, chroma]
            : sector < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];

  // Value is pinned at 1: HomeKit's Brightness owns the V axis, and it reaches
  // the bulb through genLevelCtrl instead.
  const offset = 1 - chroma;
  return [r + offset, g + offset, b + offset];
};

const rgbToHueSat = (r: number, g: number, b: number): HueSat => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  if (delta === 0 || max === 0) return { hue: 0, saturation: 0 };

  const hue =
    max === r
      ? 60 * (((g - b) / delta + 6) % 6)
      : max === g
        ? 60 * ((b - r) / delta + 2)
        : 60 * ((r - g) / delta + 4);

  return {
    hue: Math.round(hue) % 360,
    saturation: Math.round((delta / max) * 100),
  };
};
