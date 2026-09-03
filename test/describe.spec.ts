/**
 * What a radio failure looks like in the user's log.
 *
 * herdsman renders a failed command as the entire request — every option it
 * was sent with, plus the raw APS frame — and that landed verbatim in the
 * Homebridge log every time a lamp was switched off at the wall. These specs
 * pin the summary down to the clause a person can act on.
 */
import { describe as group, expect, it } from "vitest";

import { describe, describeCommandFailure } from "#util/describe";

const HERDSMAN_TIMEOUT =
  'ZCL command 0x001788010cb97916/11 genOnOff.off({}, {"timeout":10000,' +
  '"disableResponse":false,"disableRecovery":false,"disableDefaultResponse":false,' +
  '"direction":0,"reservedBits":0,"writeUndiv":false}) failed ' +
  '({"target":30636,"apsFrame":{"profileId":260,"clusterId":6,"sourceEndpoint":1,' +
  '"destinationEndpoint":11,"options":4416,"groupId":0,"sequence":206},' +
  '"zclSequence":52,"commandIdentifier":11} timed out after 10000ms)';

group("describeCommandFailure", () => {
  it("keeps the command and the reason, and drops the frame", () => {
    const summary = describeCommandFailure(new Error(HERDSMAN_TIMEOUT));

    expect(summary).toBe("genOnOff.off got no answer within 10s");
    expect(summary).not.toContain("apsFrame");
  });

  it("names the status when the device answered with a refusal", () => {
    const summary = describeCommandFailure(
      new Error("ZCL command 0x00/1 lightingColorCtrl.moveToColor({}) failed (Status 'FAILURE')"),
    );

    expect(summary).toBe("lightingColorCtrl.moveToColor was refused (FAILURE)");
  });

  it("falls back to the plain rendering for anything else", () => {
    const error = new Error("Cannot lock port /dev/zigbee");

    expect(describeCommandFailure(error)).toBe(describe(error));
  });

  it("survives a throw that is not an Error", () => {
    expect(describeCommandFailure("no adapter")).toBe("no adapter");
  });
});
