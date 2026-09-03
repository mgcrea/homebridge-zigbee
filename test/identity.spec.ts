/**
 * The network identity is the one thing in this plugin that cannot be
 * regenerated. zoh compares the PAN ID, extended PAN ID and network key against
 * its own save file, and forms a brand-new network if any of the three differ —
 * which unpairs every device on the old one.
 *
 * So these specs are mostly about what the code refuses to do.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { IdentityError, loadOrCreateIdentity, writeStackConfig } from "#zigbee/identity";

let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "zigbee-identity-"));
  path = join(directory, "identity.json");
});

describe("loadOrCreateIdentity", () => {
  it("generates a usable identity on first run", () => {
    const identity = loadOrCreateIdentity(path);

    expect(identity.networkKey).toHaveLength(16);
    expect(identity.extendedPanId).toHaveLength(8);
    expect(identity.panId).toBeGreaterThan(0x0000);
    expect(identity.panId).toBeLessThan(0xffff);
    expect(identity.eui64).toMatch(/^0x[0-9a-f]{16}$/);
  });

  it("does not use a predictable network key", () => {
    const a = loadOrCreateIdentity(path);
    const b = loadOrCreateIdentity(join(mkdtempSync(join(tmpdir(), "zb-")), "identity.json"));
    expect(a.networkKey).not.toEqual(b.networkKey);
  });

  it("returns byte-identical values on every later run", () => {
    const first = loadOrCreateIdentity(path);
    const second = loadOrCreateIdentity(path);

    // Any drift here re-forms the network and unpairs everything on it.
    expect(second).toEqual(first);
  });

  it("keeps the key file unreadable by other users", () => {
    loadOrCreateIdentity(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses to start on a corrupt file rather than forming a new network", () => {
    writeFileSync(path, "{ not json");
    expect(() => loadOrCreateIdentity(path)).toThrow(IdentityError);
  });

  it("refuses a file that parses but is missing the key", () => {
    writeFileSync(path, JSON.stringify({ version: 1, panId: 4660 }));
    expect(() => loadOrCreateIdentity(path)).toThrow(/unpair/i);
  });

  it("refuses a truncated network key", () => {
    const good = loadOrCreateIdentity(path);
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...stored, networkKey: "0011" }));

    expect(() => loadOrCreateIdentity(path)).toThrow(IdentityError);
    expect(good.networkKey).toHaveLength(16);
  });
});

describe("writeStackConfig", () => {
  it("gives the coordinator its own EUI64 instead of zoh's shared default", () => {
    const identity = loadOrCreateIdentity(path);
    const configPath = writeStackConfig(directory, identity);

    const written = JSON.parse(readFileSync(configPath, "utf8")) as { eui64: string };
    // zoh's default is the ASCII bytes "ZoHonZ2M", identical on every install.
    expect(written.eui64).toBe(identity.eui64);
    expect(written.eui64).not.toBe("0x5a6f486f6e5a324d");
  });

  it("preserves settings a user put in the stack config by hand", () => {
    const identity = loadOrCreateIdentity(path);
    writeFileSync(join(directory, "zoh_config.json"), JSON.stringify({ ccaRetries: 8 }));

    const configPath = writeStackConfig(directory, identity);
    const written = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;

    expect(written["ccaRetries"]).toBe(8);
    expect(written["eui64"]).toBe(identity.eui64);
  });
});

describe("the EUI64", () => {
  /**
   * zoh's failure mode for an unusable EUI64 is silent. It logs at its own
   * error level and falls back to a hard-coded constant — the ASCII bytes
   * `ZoHonZ2M` — which every install of zoh in the world shares. Two
   * coordinators within radio range would then claim the same IEEE address,
   * which is precisely what this file exists to prevent, so it is checked here
   * rather than merely for being a string.
   */
  const write = (eui64: unknown): void => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        networkKey: "000102030405060708090a0b0c0d0e0f",
        panId: 0x1234,
        extendedPanId: "0001020304050607",
        eui64,
      }),
    );
  };

  it("accepts the form zoh's BigInt() can actually parse", () => {
    write("0x00124b0029AB1234");
    expect(loadOrCreateIdentity(path).eui64).toBe("0x00124b0029AB1234");
  });

  it.each([
    ["missing its 0x prefix", "00124b0029ab1234"],
    ["too short", "0x00124b0029ab12"],
    ["not hex at all", "0xZoHonZ2M000000"],
    ["all zeroes, which means unset", "0x0000000000000000"],
    ["all ones, which is the broadcast address", "0xffffffffffffffff"],
    ["not a string", 42],
  ])("refuses one that is %s", (_why, eui64) => {
    write(eui64);
    expect(() => loadOrCreateIdentity(path)).toThrow(IdentityError);
  });
});

describe("an identity from a future version", () => {
  it("is refused rather than misread", () => {
    // Misreading it means forming a new network, so guessing is the one thing
    // that must not happen here.
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        networkKey: "000102030405060708090a0b0c0d0e0f",
        panId: 0x1234,
        extendedPanId: "0001020304050607",
        eui64: "0x00124b0029ab1234",
      }),
    );

    expect(() => loadOrCreateIdentity(path)).toThrow(/newer version/);
  });
});
