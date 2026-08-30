/**
 * The plugin's own view of a paired device.
 *
 * herdsman's `Device` is a live, mutable database record with a great deal on
 * it. What the accessory layer actually needs is small, flat and stable, so
 * discovery reduces one to this and the accessories never reach back.
 *
 * One endpoint becomes one HomeKit accessory. Multi-endpoint devices (a
 * two-gang switch, say) therefore surface as several accessories, which is what
 * HomeKit expects and what makes each half independently controllable.
 */
import type { Logging } from "homebridge";
import type { Models } from "zigbee-herdsman";

import type { Capability } from "#model/capability";
import { capabilitiesFrom, CLUSTER, colorSupportFrom, isLight } from "#model/capability";
import { stateKey, type StateKey } from "#model/state";
import { isMainsPowered } from "#zigbee/reporting";
import { describe } from "#util/describe";

/** HomeKit's own limits on the ColorTemperature characteristic, in mireds. */
export const HOMEKIT_MIRED_MIN = 140;
export const HOMEKIT_MIRED_MAX = 500;

export type MiredRange = { min: number; max: number };

export type DeviceView = {
  ieee: string;
  endpointId: number;
  key: StateKey;
  name: string;
  manufacturer: string;
  model: string;
  firmware: string | undefined;
  capabilities: ReadonlySet<Capability>;
  /** Present only when the light actually supports colour temperature. */
  miredRange: MiredRange | undefined;
  isLight: boolean;
  mainsPowered: boolean;
};

/**
 * Clamp a light's advertised colour-temperature range into HomeKit's.
 *
 * Bulbs routinely advertise a wider physical range than HomeKit will accept,
 * and a characteristic whose props fall outside 140-500 is rejected outright,
 * taking the whole service with it. Nonsense bounds (zero, inverted) fall back
 * to HomeKit's full range rather than disabling the control.
 */
export const clampMiredRange = (
  physicalMin: number | undefined,
  physicalMax: number | undefined,
): MiredRange => {
  const min = physicalMin && physicalMin > 0 ? physicalMin : HOMEKIT_MIRED_MIN;
  const max = physicalMax && physicalMax > 0 ? physicalMax : HOMEKIT_MIRED_MAX;

  const low = Math.max(HOMEKIT_MIRED_MIN, Math.min(min, max));
  const high = Math.min(HOMEKIT_MIRED_MAX, Math.max(min, max));

  return high > low ? { min: low, max: high } : { min: HOMEKIT_MIRED_MIN, max: HOMEKIT_MIRED_MAX };
};

/**
 * Interrogate one endpoint and describe what it can do.
 *
 * The colour reads are best-effort: a light that will not answer them is still
 * exposed, just without the colour controls it would not have honoured anyway.
 */
export const describeEndpoint = async (
  device: Models.Device,
  endpoint: Models.Endpoint,
  log: Logging,
): Promise<DeviceView> => {
  let colorCapabilities: number | undefined;
  let physicalMin: number | undefined;
  let physicalMax: number | undefined;

  if (endpoint.supportsInputCluster(CLUSTER.color)) {
    try {
      const read = await endpoint.read("lightingColorCtrl", [
        "colorCapabilities",
        "colorTempPhysicalMin",
        "colorTempPhysicalMax",
      ]);
      colorCapabilities = numeric(read["colorCapabilities"]);
      physicalMin = numeric(read["colorTempPhysicalMin"]);
      physicalMax = numeric(read["colorTempPhysicalMax"]);
    } catch (error) {
      log.debug(
        `${device.ieeeAddr} would not report its colour capabilities: ${describe(error)}. ` +
          "Colour controls will be omitted for it.",
      );
    }
  }

  const color = endpoint.supportsInputCluster(CLUSTER.color)
    ? colorSupportFrom(colorCapabilities, physicalMin !== undefined && physicalMax !== undefined)
    : undefined;

  const capabilities = capabilitiesFrom(endpoint, color);

  return {
    ieee: device.ieeeAddr,
    endpointId: endpoint.ID,
    key: stateKey(device.ieeeAddr, endpoint.ID),
    name: defaultName(device, endpoint),
    manufacturer: device.manufacturerName?.trim() || "Zigbee",
    model: device.modelID?.trim() || "Unknown",
    firmware: device.softwareBuildID?.trim() || undefined,
    capabilities,
    miredRange: capabilities.has("colorTemperature")
      ? clampMiredRange(physicalMin, physicalMax)
      : undefined,
    isLight: isLight(capabilities, endpoint.deviceID),
    mainsPowered: isMainsPowered(device),
  };
};

const numeric = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * A name to show before the user renames it in the Home app.
 *
 * The endpoint number is only appended for genuinely multi-endpoint devices,
 * where "Bulb" and "Bulb" would otherwise be indistinguishable.
 */
const defaultName = (device: Models.Device, endpoint: Models.Endpoint): string => {
  const base = device.modelID?.trim() || device.ieeeAddr;
  const controllable = device.endpoints.filter(
    (candidate) => candidate.getInputClusters().length > 0,
  );
  return controllable.length > 1 ? `${base} ${endpoint.ID}` : base;
};
