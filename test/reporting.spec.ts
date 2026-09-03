/**
 * Reporting is what makes a light changed elsewhere show up in HomeKit. The
 * behaviour worth pinning down is what happens when a device refuses part of
 * it — observed on a real Hue Play, which accepted onOff and currentLevel but
 * left the colour cluster with no reporting at all.
 */
import type { Logging } from "homebridge";
import type { Models } from "zigbee-herdsman";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { configureReporting, refresh } from "#zigbee/reporting";

type Item = { attribute: string; reportableChange?: number };

class FakeEndpoint {
  readonly deviceIeeeAddress = "0x0017880102030405";
  readonly bound: string[] = [];
  readonly configured: { cluster: string; items: Item[] }[] = [];
  /** Attributes the device refuses to report on. */
  refuse = new Set<string>();
  /** Clusters whose reads go unanswered. */
  unreadable = new Set<string>();
  readonly reads: string[] = [];

  async bind(cluster: string): Promise<void> {
    this.bound.push(String(cluster));
    await Promise.resolve();
  }
  async configureReporting(cluster: string, items: Item[]): Promise<void> {
    await Promise.resolve();
    if (items.some((i) => this.refuse.has(i.attribute))) throw new Error("UNSUPPORTED_ATTRIBUTE");
    this.configured.push({ cluster: String(cluster), items });
  }
  async read(cluster: string): Promise<Record<string, unknown>> {
    await Promise.resolve();
    this.reads.push(String(cluster));
    if (this.unreadable.has(String(cluster))) throw new Error("timed out after 10000ms");
    return {};
  }
  supportsInputCluster(): boolean {
    return true;
  }
}

let endpoint: FakeEndpoint;
let log: Logging;

const attributesConfigured = (): string[] =>
  endpoint.configured.flatMap((c) => c.items.map((i) => i.attribute));

const run = async (): Promise<void> => {
  await configureReporting(endpoint as unknown as Models.Endpoint, {} as Models.Endpoint, log);
};

beforeEach(() => {
  endpoint = new FakeEndpoint();
  log = {
    info: vi.fn<(m: string) => void>(),
    warn: vi.fn<(m: string) => void>(),
    error: vi.fn<(m: string) => void>(),
    debug: vi.fn<(m: string) => void>(),
  } as unknown as Logging;
});

describe("configureReporting", () => {
  it("configures every attribute the light will accept", async () => {
    await run();
    expect(attributesConfigured()).toEqual([
      "onOff",
      "currentLevel",
      "colorTemperature",
      "colorMode",
      "currentX",
      "currentY",
    ]);
  });

  it("sends each attribute as its own request", async () => {
    await run();
    // One refused record fails the whole command, so batching would lose the
    // attributes the device was perfectly willing to report.
    expect(endpoint.configured.every((c) => c.items.length === 1)).toBe(true);
  });

  it("keeps the rest when a device refuses one attribute", async () => {
    endpoint.refuse.add("colorTemperature");
    await run();

    const configured = attributesConfigured();
    expect(configured).not.toContain("colorTemperature");
    expect(configured).toContain("currentX");
    expect(configured).toContain("currentY");
    expect(configured).toContain("onOff");
  });

  it("omits reportableChange for discrete attributes", async () => {
    await run();
    const byName = new Map(
      endpoint.configured.flatMap((c) => c.items).map((i) => [i.attribute, i]),
    );

    // BOOLEAN and ENUM8 have no notion of "changed by more than N", and sending
    // one is what made the colour cluster's whole request fail.
    expect(byName.get("onOff")?.reportableChange).toBeUndefined();
    expect(byName.get("colorMode")?.reportableChange).toBeUndefined();
    // Analog types still carry one.
    expect(byName.get("currentLevel")?.reportableChange).toBe(1);
    expect(byName.get("currentX")?.reportableChange).toBe(256);
  });

  it("says out loud which attributes fell back to polling", async () => {
    endpoint.refuse.add("currentX");
    await run();

    const said = vi
      .mocked(log.info)
      .mock.calls.map((c) => String(c[0]))
      .join(" ");
    expect(said).toContain("currentX");
    expect(said).toMatch(/refresh|poll/i);
  });

  it("stays quiet when everything worked", async () => {
    await run();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("does not configure reporting for a cluster it could not bind", async () => {
    endpoint.bind = async () => {
      await Promise.resolve();
      throw new Error("no route");
    };
    await run();
    expect(endpoint.configured).toHaveLength(0);
  });
});

describe("refresh", () => {
  const poll = async (): Promise<boolean> =>
    await refresh(endpoint as unknown as Models.Endpoint, log);

  it("reads every cluster of a device that is answering", async () => {
    expect(await poll()).toBe(true);
    expect(endpoint.reads).toEqual(["genOnOff", "genLevelCtrl", "lightingColorCtrl"]);
  });

  it("gives up on a device that did not answer its first read", async () => {
    // Each further read would spend its own ten-second timeout rediscovering
    // the same absence, and the adapter runs one transaction at a time — so
    // this is the difference between blocking the radio for ten seconds and
    // blocking it for thirty.
    endpoint.unreadable = new Set(["genOnOff", "genLevelCtrl", "lightingColorCtrl"]);

    expect(await poll()).toBe(false);
    expect(endpoint.reads).toEqual(["genOnOff"]);
  });

  it("presses on past a single cluster a reachable device would not answer", async () => {
    endpoint.unreadable = new Set(["lightingColorCtrl"]);

    expect(await poll()).toBe(true);
    expect(endpoint.reads).toEqual(["genOnOff", "genLevelCtrl", "lightingColorCtrl"]);
  });
});
