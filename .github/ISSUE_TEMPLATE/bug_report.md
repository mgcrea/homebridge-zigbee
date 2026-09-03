---
name: Bug report
about: Create a report to help us improve
title: ''
labels: ''
assignees: ''
---

**Describe the bug**

<!-- A clear and concise description of what the bug is. -->

**Expected behavior**

<!-- A clear and concise description of what you expected to happen. -->

**Coordinator**

<!--
The stick, and the FIRMWARE actually on it — they are routinely different, and the
firmware is what `adapter` has to match. For a Silicon Labs stick:

  pipx run universal-silabs-flasher --device /dev/ttyACM0 --bootloader-reset baudrate probe

Paste the "Detected ApplicationType..." line it prints.
-->

- Stick:
- Firmware:
- `adapter`:

**Related hardware**

<!-- If a specific device misbehaves, its official product name (eg. Hue White Ambiance E27). -->

**Devices**

<!--
`pnpm diagnose` prints every paired device, its endpoints, its clusters and the
capabilities this plugin derives from them — which is what decides how a device is
exposed. Stop Homebridge first, it cannot share the radio.

  ZIGBEE_PORT=/dev/serial/by-id/usb-... pnpm diagnose

Paste the output, or upload it to https://gist.github.com
-->

**Logs**

<!--
Set `"debug": true` in the platform's configuration and restart. That logs every
Zigbee frame in both directions, which is what makes a radio problem diagnosable.
-->

**Versions**

<!-- Please make sure you are using the latest available version published on npm. -->

- homebridge-zigbee: `v0.x.x`
- homebridge:
- node:

**Additional context**

<!-- Add any other context about the problem here. -->
