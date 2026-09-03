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
import { z } from "zod";

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
 * What an endpoint had to be asked, as opposed to what its descriptors already
 * said.
 *
 * Everything else in a `DeviceView` comes from the interview, which herdsman
 * has already done and stored. These four attributes are the only part that
 * costs radio, so they are the only part worth remembering across a restart —
 * and they do not change for a device that is still the same device.
 */
export type EndpointProbe = {
  version: 1;
  productLabel: string | undefined;
  colorCapabilities: number | undefined;
  colorTempPhysicalMin: number | undefined;
  colorTempPhysicalMax: number | undefined;
};

const zProbe = z.object({
  version: z.literal(1),
  productLabel: z.string().optional(),
  colorCapabilities: z.number().optional(),
  colorTempPhysicalMin: z.number().optional(),
  colorTempPhysicalMax: z.number().optional(),
});

/**
 * A probe carried over from a previous run, or nothing.
 *
 * Homebridge round-trips the accessory context through JSON, and a context
 * written by an older version of this plugin is not this shape — so it is
 * validated rather than trusted, and a mismatch simply means probing again.
 */
export const storedProbe = (context: unknown): EndpointProbe | undefined => {
  if (typeof context !== "object" || context === null) return undefined;
  const parsed = zProbe.safeParse((context as Record<string, unknown>)["probe"]);
  if (!parsed.success) return undefined;

  return {
    version: 1,
    productLabel: parsed.data.productLabel,
    colorCapabilities: parsed.data.colorCapabilities,
    colorTempPhysicalMin: parsed.data.colorTempPhysicalMin,
    colorTempPhysicalMax: parsed.data.colorTempPhysicalMax,
  };
};

/**
 * Ask one endpoint the two questions its descriptors cannot answer.
 *
 * Both reads are best-effort: a light that will not answer them is still
 * exposed, just without the colour controls it would not have honoured anyway.
 * `complete` says whether the answers are worth keeping — a probe taken while
 * the light was unreachable describes the outage, not the light, and caching
 * that would make a momentary silence permanent.
 */
export const probeEndpoint = async (
  device: Models.Device,
  endpoint: Models.Endpoint,
  log: Logging,
): Promise<{ probe: EndpointProbe; complete: boolean }> => {
  let complete = true;

  // Optional in the ZCL and absent on plenty of devices, so this is best-effort
  // and never allowed to fail discovery.
  let productLabel: string | undefined;
  try {
    const basic = await endpoint.read("genBasic", ["productLabel"]);
    const value = basic["productLabel"];
    if (typeof value === "string") productLabel = value;
  } catch {
    // Unsupported attribute; the vendor + device-type fallback covers it. Not
    // a reason to withhold the probe: a device that does not implement the
    // attribute will never implement it.
  }

  let colorCapabilities: number | undefined;
  let colorTempPhysicalMin: number | undefined;
  let colorTempPhysicalMax: number | undefined;

  if (endpoint.supportsInputCluster(CLUSTER.color)) {
    try {
      const read = await endpoint.read("lightingColorCtrl", [
        "colorCapabilities",
        "colorTempPhysicalMin",
        "colorTempPhysicalMax",
      ]);
      colorCapabilities = numeric(read["colorCapabilities"]);
      colorTempPhysicalMin = numeric(read["colorTempPhysicalMin"]);
      colorTempPhysicalMax = numeric(read["colorTempPhysicalMax"]);
    } catch (error) {
      complete = false;
      log.debug(
        `${device.ieeeAddr} would not report its colour capabilities: ${describe(error)}. ` +
          "Colour controls will be omitted for it.",
      );
    }
  }

  return {
    probe: {
      version: 1,
      productLabel,
      colorCapabilities,
      colorTempPhysicalMin,
      colorTempPhysicalMax,
    },
    complete,
  };
};

/**
 * Describe one endpoint from its descriptors plus a probe.
 *
 * Pure: everything it needs is either already in herdsman's database or in the
 * probe handed to it, so a rediscovery of a device already adopted costs no
 * radio at all.
 */
export const viewFrom = (
  device: Models.Device,
  endpoint: Models.Endpoint,
  probe: EndpointProbe,
): DeviceView => {
  const hasBounds =
    probe.colorTempPhysicalMin !== undefined && probe.colorTempPhysicalMax !== undefined;

  const color = endpoint.supportsInputCluster(CLUSTER.color)
    ? colorSupportFrom(probe.colorCapabilities, hasBounds)
    : undefined;

  const capabilities = capabilitiesFrom(endpoint, color);

  return {
    ieee: device.ieeeAddr,
    endpointId: endpoint.ID,
    key: stateKey(device.ieeeAddr, endpoint.ID),
    name: defaultName(device, endpoint, probe.productLabel),
    manufacturer: device.manufacturerName?.trim() || "Zigbee",
    model: device.modelID?.trim() || "Unknown",
    firmware: device.softwareBuildID?.trim() || undefined,
    capabilities,
    miredRange: capabilities.has("colorTemperature")
      ? clampMiredRange(probe.colorTempPhysicalMin, probe.colorTempPhysicalMax)
      : undefined,
    isLight: isLight(capabilities, endpoint.deviceID),
    mainsPowered: isMainsPowered(device),
  };
};

const numeric = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Vendor strings as they appear on the wire, and what people actually call them.
 *
 * `manufacturerName` is a legal entity — "Signify Netherlands B.V." — which is
 * nobody's name for the thing on their shelf.
 */
const VENDOR_ALIASES: readonly (readonly [RegExp, string])[] = [
  [/^signify|^philips/i, "Hue"],
  [/^ikea/i, "IKEA"],
  [/^lumi|^xiaomi|^aqara/i, "Aqara"],
  [/^_tz|^tuya/i, "Tuya"],
  [/^innr/i, "Innr"],
  [/^ledvance|^osram/i, "Ledvance"],
  [/^gledopto/i, "Gledopto"],
];

/**
 * Zigbee device identifiers as a noun a person would use.
 *
 * These come from the endpoint's simple descriptor, so they cost nothing to
 * read and cover every device of a type rather than every model of one.
 */
const DEVICE_TYPE_NAMES = new Map<number, string>([
  [0x0051, "Smart Plug"],
  [0x0100, "Light"],
  [0x0101, "Dimmable Light"],
  [0x0102, "Colour Light"],
  [0x010c, "White Light"],
  [0x010d, "Colour Light"],
]);

const vendorAlias = (manufacturerName: string | undefined): string | undefined => {
  const name = manufacturerName?.trim();
  if (!name) return undefined;
  for (const [pattern, alias] of VENDOR_ALIASES) {
    if (pattern.test(name)) return alias;
  }
  // An unrecognised vendor is still better shown than hidden — but a legal
  // suffix is noise in a HomeKit tile.
  return name.replace(/\s+(B\.?V\.?|GmbH|Ltd\.?|Inc\.?|Co\.?,?\s*Ltd\.?)\.?$/i, "").trim();
};

/**
 * A name to show before the user renames it in the Home app.
 *
 * Preference order is deliberate. `genBasic.productLabel` exists in the ZCL for
 * exactly this purpose, so a device that fills it in wins outright. Failing
 * that, the vendor plus the Zigbee device type reads far better than the raw
 * `modelId`, which is a part number: "Hue Colour Light", not "440400982842".
 *
 * Nothing here is a device database — every input is something the device
 * already told us during its interview.
 */
export const friendlyName = (
  device: Pick<Models.Device, "manufacturerName" | "modelID" | "ieeeAddr">,
  deviceId: number | undefined,
  productLabel: string | undefined,
): string => {
  const label = productLabel?.trim();
  if (label) return label;

  const vendor = vendorAlias(device.manufacturerName);
  const noun = deviceId === undefined ? undefined : DEVICE_TYPE_NAMES.get(deviceId);
  const model = device.modelID?.trim();

  if (vendor && noun) return `${vendor} ${noun}`;
  if (vendor && model) return `${vendor} ${model}`;
  if (vendor) return vendor;
  return model || device.ieeeAddr;
};

/**
 * The endpoint number is only appended for genuinely multi-endpoint devices,
 * where two identical names would otherwise be indistinguishable.
 */
const defaultName = (
  device: Models.Device,
  endpoint: Models.Endpoint,
  productLabel: string | undefined,
): string => {
  const base = friendlyName(device, endpoint.deviceID, productLabel);
  const controllable = device.endpoints.filter(
    (candidate) => candidate.getInputClusters().length > 0,
  );
  return controllable.length > 1 ? `${base} ${endpoint.ID}` : base;
};
