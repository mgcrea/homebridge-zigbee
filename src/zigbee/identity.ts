/**
 * The coordinator's network identity, generated once and then never allowed to
 * change.
 *
 * This is the single most consequential file in the plugin, because of how the
 * `zoh` adapter decides whether to keep a network or form a new one. On start
 * it compares the configured PAN ID, extended PAN ID and network key against
 * what its own `zoh.save` holds, and if any of the three differ it calls
 * `resetNetwork()` and reports `"reset"`. A network reset unpairs every device
 * on it.
 *
 * So these values cannot be derived, defaulted, or regenerated. They are
 * generated once with a CSPRNG, written to disk, and read back byte-identically
 * for the life of the network. They are deliberately not part of config.json:
 * the network key is the credential that protects the mesh, and Homebridge's
 * config is world-readable, gets pasted into forum posts, and is served by the
 * config UI.
 */
import { randomBytes, randomInt } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Reserved by the spec, and the value stacks use to mean "unset". */
const INVALID_PAN_IDS = new Set([0x0000, 0xffff]);

/** `0x` and sixteen hex digits, which is what zoh's `BigInt()` will accept. */
const EUI64 = /^0x[0-9a-f]{16}$/i;

/**
 * The two EUI64 values that mean "nobody".
 *
 * All-zero is the unset value; all-ones is the 802.15.4 broadcast address.
 * Either one hands the radio an address it cannot be reached at.
 */
const INVALID_EUI64 = new Set(["0x0000000000000000", "0xffffffffffffffff"]);

/** The only shape of stored identity this version knows how to read. */
const IDENTITY_VERSION = 1;

export type NetworkIdentity = {
  /** 16 bytes. */
  networkKey: number[];
  panId: number;
  /** 8 bytes. */
  extendedPanId: number[];
  /** `0x`-prefixed 16 hex digits, as zoh's stack config wants it. */
  eui64: string;
};

type StoredIdentity = {
  version: number;
  networkKey: string;
  panId: number;
  extendedPanId: string;
  eui64: string;
};

const toHex = (bytes: readonly number[]): string => Buffer.from(bytes).toString("hex");

const fromHex = (hex: string, expectedLength: number): number[] | undefined => {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length !== expectedLength * 2) return undefined;
  return [...Buffer.from(hex, "hex")];
};

export class IdentityError extends Error {
  override readonly name = "IdentityError";
}

/**
 * Load the identity from `path`, or create and persist one if it is absent.
 *
 * A file that exists but cannot be parsed is an error, never a reason to
 * generate a fresh identity — silently regenerating is exactly how every paired
 * device gets dropped.
 */
export const loadOrCreateIdentity = (path: string): NetworkIdentity => {
  const existing = readIdentity(path);
  if (existing) return existing;

  const identity: NetworkIdentity = {
    networkKey: [...randomBytes(16)],
    // Avoid the reserved values; anything else in range is fine.
    panId: randomInt(0x0001, 0xfff0),
    extendedPanId: [...randomBytes(8)],
    eui64: `0x${randomBytes(8).toString("hex")}`,
  };

  writeIdentity(path, identity);
  return identity;
};

const readIdentity = (path: string): NetworkIdentity | undefined => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new IdentityError(
      `Could not read the Zigbee network identity at ${path}: ${String(error)}. ` +
        "Refusing to start rather than forming a new network and unpairing every device.",
    );
  }

  let parsed: StoredIdentity;
  try {
    parsed = JSON.parse(raw) as StoredIdentity;
  } catch (error) {
    throw new IdentityError(
      `The Zigbee network identity at ${path} is not valid JSON (${String(error)}). ` +
        "Restore it from a backup, or delete it to form a new network from scratch — " +
        "every device would then need to be paired again.",
    );
  }

  const networkKey = fromHex(parsed.networkKey ?? "", 16);
  const extendedPanId = fromHex(parsed.extendedPanId ?? "", 8);
  const eui64 = typeof parsed.eui64 === "string" ? parsed.eui64.trim() : undefined;

  // The EUI64 is checked properly rather than merely for being a string,
  // because zoh's failure mode for an unparsable one is silent: it logs at its
  // own error level and falls back to a hard-coded constant — the ASCII bytes
  // `ZoHonZ2M` — which every install of it shares. Two coordinators within
  // range would then claim the same IEEE address, which is the exact thing
  // this file exists to prevent.
  const usableEui64 =
    eui64 !== undefined && EUI64.test(eui64) && !INVALID_EUI64.has(eui64.toLowerCase());

  if (
    !networkKey ||
    !extendedPanId ||
    typeof parsed.panId !== "number" ||
    INVALID_PAN_IDS.has(parsed.panId) ||
    !usableEui64
  ) {
    throw new IdentityError(
      `The Zigbee network identity at ${path} is incomplete or malformed. ` +
        "Refusing to start: forming a new network here would unpair every device.",
    );
  }

  // A future version may store something this one would misread, and
  // misreading it means forming a new network.
  if (parsed.version !== undefined && parsed.version !== IDENTITY_VERSION) {
    throw new IdentityError(
      `The Zigbee network identity at ${path} was written by a newer version of this plugin ` +
        `(version ${String(parsed.version)}, this one understands ${IDENTITY_VERSION}). ` +
        "Refusing to start rather than guessing at it and forming a new network.",
    );
  }

  return { networkKey, panId: parsed.panId, extendedPanId, eui64 };
};

const writeIdentity = (path: string, identity: NetworkIdentity): void => {
  const stored: StoredIdentity = {
    version: IDENTITY_VERSION,
    networkKey: toHex(identity.networkKey),
    panId: identity.panId,
    extendedPanId: toHex(identity.extendedPanId),
    eui64: identity.eui64,
  };

  mkdirSync(dirname(path), { recursive: true });

  // Write-then-rename, so an interrupted write cannot leave a half-file that
  // the next start would refuse to parse.
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
};

/**
 * Write zoh's own stack config next to its save file.
 *
 * Only the EUI64 is set here, and only because zoh's default is a hard-coded
 * constant (the ASCII bytes `ZoHonZ2M`) shared by every install of it. Two
 * coordinators within radio range of each other would otherwise claim the same
 * IEEE address.
 */
export const writeStackConfig = (stateDirectory: string, identity: NetworkIdentity): string => {
  const path = join(stateDirectory, "zoh_config.json");
  mkdirSync(stateDirectory, { recursive: true });

  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // A missing or unreadable stack config is not fatal — unlike the identity,
    // zoh falls back to documented defaults for everything in it.
  }

  if (current["eui64"] === identity.eui64) return path;

  // Write-then-rename, like the identity itself. zoh reads this file at start
  // and shrugs off anything it cannot parse — by falling back to the shared
  // constant, which is precisely the outcome worth ruling out.
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...current, eui64: identity.eui64 }, null, 2)}\n`);
  renameSync(temporary, path);
  return path;
};
