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
  version: 1;
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

  if (
    !networkKey ||
    !extendedPanId ||
    typeof parsed.panId !== "number" ||
    INVALID_PAN_IDS.has(parsed.panId) ||
    typeof parsed.eui64 !== "string"
  ) {
    throw new IdentityError(
      `The Zigbee network identity at ${path} is incomplete or malformed. ` +
        "Refusing to start: forming a new network here would unpair every device.",
    );
  }

  return { networkKey, panId: parsed.panId, extendedPanId, eui64: parsed.eui64 };
};

const writeIdentity = (path: string, identity: NetworkIdentity): void => {
  const stored: StoredIdentity = {
    version: 1,
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

  writeFileSync(path, `${JSON.stringify({ ...current, eui64: identity.eui64 }, null, 2)}\n`);
  return path;
};
