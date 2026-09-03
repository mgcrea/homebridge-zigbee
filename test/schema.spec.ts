/**
 * The schema is what the Homebridge UI renders, and it drifts.
 *
 * `ezsp` was accepted by `parseConfig` and missing from the schema's adapter
 * list, which is worse than it sounds: the Config UI does not merely fail to
 * offer it, it blanks the field on save — so opening the settings page once
 * silently unset the adapter of anyone using it. These tests tie the schema
 * back to `parseConfig`, which is the actual definition of what the plugin
 * accepts.
 */
import { readFileSync } from "node:fs";
import type { PlatformConfig } from "homebridge";
import { describe, expect, it } from "vitest";

import { ADAPTERS, parseConfig } from "#config";
import { PLATFORM_NAME } from "#settings";

const schema = JSON.parse(
  readFileSync(new URL("../config.schema.json", import.meta.url), "utf8"),
) as {
  pluginAlias: string;
  pluginType: string;
  schema: {
    properties: Record<string, { default?: unknown; oneOf?: { enum: string[] }[] }>;
  };
};

const properties = schema.schema.properties;

const parsed = parseConfig({
  platform: PLATFORM_NAME,
  port: "/dev/serial/by-id/usb-x",
} as PlatformConfig);

describe("config.schema.json", () => {
  it("declares the alias every installed user already has in their config.json", () => {
    // Changing this orphans the platform block in every existing install.
    expect(schema.pluginAlias).toBe(PLATFORM_NAME);
    expect(schema.pluginType).toBe("platform");
  });

  it("offers exactly the options parseConfig reads", () => {
    // Both directions matter. A key parseConfig reads but the schema omits is
    // reachable only by hand-editing config.json; a key the schema offers but
    // parseConfig ignores is a control that does nothing.
    expect(Object.keys(properties).toSorted()).toEqual(Object.keys(parsed).toSorted());
  });

  it("offers every adapter zigbee-herdsman actually has", () => {
    const offered = (properties["adapter"]?.oneOf ?? []).flatMap((option) => option.enum);
    expect(offered.toSorted()).toEqual([...ADAPTERS].toSorted());
  });

  it("agrees with parseConfig about the defaults it advertises", () => {
    // A default in the schema is what the UI writes into config.json, so one
    // that disagrees with the code is a silent behaviour change on first save.
    for (const [key, property] of Object.entries(properties)) {
      if (property.default === undefined) continue;
      expect({ [key]: property.default }).toEqual({
        [key]: parsed[key as keyof typeof parsed],
      });
    }
  });

  it("advertises no default for the line settings, which herdsman detects", () => {
    // A default here is not merely redundant: it overrides the per-adapter
    // detection and stops a ConBee or a Z-Stack stick opening at all.
    expect(properties["baudRate"]?.default).toBeUndefined();
    expect(properties["rtscts"]?.default).toBeUndefined();
  });
});
