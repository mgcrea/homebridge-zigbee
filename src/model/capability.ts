/**
 * What a device can do, worked out from its ZCL clusters rather than a lookup
 * table of model names.
 *
 * This is the whole reason the plugin carries no device database. HomeKit
 * services map onto clusters, not onto products: a bulb nobody has ever heard
 * of still advertises `genOnOff` and `genLevelCtrl`, and that is all the
 * information needed to expose it correctly.
 */
import type { Models } from "zigbee-herdsman";

export const CLUSTER = {
  onOff: "genOnOff",
  level: "genLevelCtrl",
  color: "lightingColorCtrl",
} as const;

/** Bit positions in `lightingColorCtrl.colorCapabilities` (attribute 0x400a). */
const COLOR_CAPABILITY_BIT = {
  hueSaturation: 0,
  xy: 3,
  colorTemperature: 4,
} as const;

export type Capability = "onOff" | "brightness" | "colorTemperature" | "color";

export type ColorSupport = {
  xy: boolean;
  hueSaturation: boolean;
  colorTemperature: boolean;
};

/**
 * Which colour features the endpoint claims.
 *
 * `colorCapabilities` is mandatory in ZCL 6 and later, but plenty of older
 * lights either omit it or answer with nonsense. When it cannot be read, the
 * presence of readable physical colour-temperature bounds is used as the
 * fallback signal, and a light that answers neither is exposed as neither.
 *
 * Guessing upward is the thing to avoid here: exposing Hue and Saturation on a
 * bulb that cannot do colour leaves a colour wheel in the Home app that
 * silently does nothing, which is worse than a missing control.
 */
export const colorSupportFrom = (
  colorCapabilities: number | undefined,
  hasPhysicalBounds: boolean,
): ColorSupport => {
  if (colorCapabilities === undefined || Number.isNaN(colorCapabilities)) {
    return { xy: false, hueSaturation: false, colorTemperature: hasPhysicalBounds };
  }

  const bit = (position: number): boolean => (colorCapabilities & (1 << position)) !== 0;

  return {
    xy: bit(COLOR_CAPABILITY_BIT.xy),
    hueSaturation: bit(COLOR_CAPABILITY_BIT.hueSaturation),
    colorTemperature: bit(COLOR_CAPABILITY_BIT.colorTemperature),
  };
};

/** The capabilities an endpoint's input clusters imply. */
export const capabilitiesFrom = (
  endpoint: Pick<Models.Endpoint, "supportsInputCluster">,
  color: ColorSupport | undefined,
): Set<Capability> => {
  const capabilities = new Set<Capability>();

  if (endpoint.supportsInputCluster(CLUSTER.onOff)) capabilities.add("onOff");
  if (endpoint.supportsInputCluster(CLUSTER.level)) capabilities.add("brightness");

  if (endpoint.supportsInputCluster(CLUSTER.color) && color) {
    if (color.colorTemperature) capabilities.add("colorTemperature");
    // Either colour space is enough to drive the light; xy is preferred at the
    // command layer, but a hue/sat-only light is still a colour light.
    if (color.xy || color.hueSaturation) capabilities.add("color");
  }

  return capabilities;
};

/**
 * Whether a set of capabilities should become a Lightbulb rather than an Outlet.
 *
 * Anything dimmable or colour-capable is unambiguously a light. A device with
 * only `genOnOff` is decided by its Zigbee device id: the lighting profile ids
 * are lights, everything else (smart plugs, relays) becomes an Outlet, which is
 * what HomeKit users expect to see for a socket.
 */
const LIGHTING_DEVICE_IDS = new Set([
  0x0100, // On/off light
  0x0101, // Dimmable light
  0x0102, // Colour dimmable light
  0x0103, // On/off light switch (as a controlled light)
  0x010c, // White colour temperature light
  0x010d, // Extended colour light
]);

export const isLight = (
  capabilities: ReadonlySet<Capability>,
  deviceId: number | undefined,
): boolean => {
  if (
    capabilities.has("brightness") ||
    capabilities.has("color") ||
    capabilities.has("colorTemperature")
  ) {
    return true;
  }
  return deviceId !== undefined && LIGHTING_DEVICE_IDS.has(deviceId);
};
