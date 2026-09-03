# homebridge-zigbee

Homebridge plugin that drives a Zigbee coordinator **directly** and exposes the lights and
outlets paired to it in HomeKit. No Hue bridge, no zigbee2mqtt, no MQTT broker — Homebridge owns
the radio.

## How it decides what a device is

There is no device database. Instead the plugin reads each endpoint's ZCL input clusters and maps
those onto HomeKit services:

| Cluster | HomeKit |
| --- | --- |
| `genOnOff` | `Lightbulb.On`, or `Outlet.On` for a plug |
| `genLevelCtrl` | `Lightbulb.Brightness` |
| `lightingColorCtrl` (bit 4) | `Lightbulb.ColorTemperature` |
| `lightingColorCtrl` (bits 0/3) | `Lightbulb.Hue` + `Saturation` |
| `genBasic` | Accessory information |

HomeKit services map onto clusters, not onto products, so a bulb nobody has heard of still works
— it advertises the same clusters a Hue bulb does. `lightingColorCtrl` is split by reading
`colorCapabilities` (`0x400a`) at discovery, which is how a White Ambiance bulb gets a colour
temperature slider and no colour wheel.

## Requirements

- Homebridge 2, Node 22/24/26.
- A Zigbee coordinator on a serial port, with **nothing else holding it open** — zigbee2mqtt, ZHA
  and this plugin cannot share a radio.

### Adapter, not stick

Set `adapter` to match the **firmware actually on the stick**, not the model of stick. They are
routinely different. A Home Assistant Connect ZBT-2 ships with OpenThread RCP firmware, which is
`zoh`; the same hardware flashed with the Zigbee NCP image is `ember`.

To check what is really on a Silicon Labs stick:

```bash
pipx run universal-silabs-flasher --device /dev/ttyACM0 \
  --bootloader-reset baudrate probe
```

It prints the application type and version, for example
`Detected ApplicationType.SPINEL, version 'SL-OPENTHREAD/3.1.1.0' at 460800 baudrate`.

## Configuration

```json
{
  "platform": "Zigbee",
  "port": "/dev/serial/by-id/usb-Nabu_Casa_ZBT-2_XXXXXXXX-if00",
  "adapter": "zoh",
  "channel": 15
}
```

`port` is the only required option. Everything else has a working default.

| Option | Default | What it does |
| --- | --- | --- |
| `port` | — | Path to the coordinator. Use the stable `/dev/serial/by-id/` path: `/dev/ttyACM0` renumbers across reboots and after any USB hiccup. |
| `adapter` | `zoh` | `zoh`, `ember`, `ezsp`, `zstack`, `deconz`, `zboss` or `zigate`. Match the **firmware**, not the stick — see above. |
| `baudRate` | detected | Leave unset. zigbee-herdsman knows the right rate per adapter (460800 for a ZBT-2, 115200 for a Z-Stack stick, 38400 for a ConBee), and setting it wrong stops the port opening at all. |
| `rtscts` | detected | Same: leave unset unless your firmware needs flow control forced one way. |
| `channel` | `15` | The 802.15.4 channel to form the network on. **Changing it after devices are paired strands them.** |
| `adaptiveLighting` | `true` | Offer Apple's Adaptive Lighting on lights that can do both dimming and colour temperature. |
| `exposePairingSwitch` | `true` | Show the *Zigbee Pairing* switch in the Home app. With it off there is no way to open the network while Homebridge is running. |
| `permitJoinDuration` | `120` | How long the pairing window stays open, in seconds. Capped at 254 by the Zigbee specification. |
| `refreshInterval` | `300` | How often mains-powered devices are re-read, in seconds. A safety net for lights that refused to report changes on their own; battery devices are never polled. |
| `transitionTime` | `0.4` | How long a light takes to fade to a new brightness or colour, in seconds. `0` snaps. |
| `allowNetworkReset` | `false` | Leave it off. See *Network state* below. |
| `debug` | `false` | Log every Zigbee frame in both directions. Very noisy. |
| `devices` | `[]` | Per-device overrides, below. |

`channel` is worth a thought. Zigbee shares the 2.4GHz band with Wi-Fi, and channels 15, 20 and
25 sit in the gaps between Wi-Fi 1, 6 and 11.

### Per-device settings

```json
{
  "devices": [
    { "ieee": "0x0017880102030405", "name": "Kitchen Ceiling" },
    { "ieee": "0x00158d0001020304", "exclude": true }
  ]
}
```

| Field | What it does |
| --- | --- |
| `ieee` | The device's address. Matched case-insensitively, with or without the `0x`. It appears in the log when the device joins, in the accessory's Serial Number in the Home app, and in `pnpm diagnose`. |
| `name` | Overrides the name the accessory is given. Renaming in the Home app afterwards always wins — that is a decision you made more recently. |
| `exclude` | Keep the device out of HomeKit entirely. |

A row that is not usable — an empty one, which the Config UI creates the moment you press *Add* —
is dropped with a warning naming the row and the field. The rest of the configuration is
unaffected.

## Pairing

Turn on the **Zigbee Pairing** switch in the Home app, then put the device into pairing mode. The
switch turns itself off when the window closes. With Homebridge stopped you can do the same from
a terminal:

```bash
ZIGBEE_PORT=/dev/serial/by-id/usb-Nabu_Casa_ZBT-2_XXXX-if00 pnpm pair 120
```

### Hue bulbs must be factory reset first

A bulb currently paired to a Hue bridge will not join. Any of these resets it:

- **Delete it in the Hue app.** If the bulb is on a Hue bridge, removing it there *is* a factory
  reset. Easiest route.
- **Power cycle, with the right timing.** Starting with the bulb **on**: off for **2 seconds**,
  on for **8 seconds**, repeated **5 times**. A quick flick of the switch does not work — the
  dwell times are what the bulb is counting. This route is unavailable if the bulb's power-on
  behaviour was set to `off`, because cutting power then will not bring it back on at all.
- **Hue Dimmer Switch.** Power cycle the bulb, hold the dimmer within ~10cm, then hold **I/On and
  0/Off together for 10-12 seconds** until the bulb flashes several times. Release a second after
  the last flash, then power cycle again.

The dimmer method is Touchlink, running directly between the dimmer and the bulb — this plugin's
coordinator is not involved, so it works regardless of what the `zoh` stack implements. What
`zoh` not implementing Touchlink *does* mean is that **the plugin itself cannot reset a bulb for
you**; you need one of the above.

## Network state, and why you should back it up

The plugin keeps everything about the network under `zigbee/` in Homebridge's storage directory:

| File | What it is |
| --- | --- |
| `identity.json` | Network key, PAN ID, extended PAN ID, coordinator EUI64. Mode `0600`. |
| `devices.db` | herdsman's device database. |
| `zoh.save` | The `zoh` stack's own network state, its equivalent of an NCP's NVRAM. |
| `zoh_config.json` | Stack tuning. Written with your coordinator's EUI64. |

`identity.json` is generated once, with a CSPRNG, and then must never change. The adapter
compares those exact bytes against its saved state on every start, and forms a **brand-new
network** if they differ — which unpairs every device. That is also why the network key is not in
`config.json`: it is the credential protecting your mesh, and Homebridge's config gets pasted
into forum posts.

If the coordinator ever does form a new network while devices were already paired, the plugin
refuses to start and says so, rather than filling the Home app with tiles backed by nothing.
Restore `zigbee/` from a backup. `allowNetworkReset` overrides this if you genuinely want to
start over.

## Adaptive Lighting

Lights that support both dimming and colour temperature are offered Apple's **Adaptive
Lighting**, which drifts them cool during the day and warm in the evening. It appears in the
light's settings in the Home app; `adaptiveLighting: false` turns it off.

It runs in hap-nodejs's AUTOMATIC mode, which drives the schedule by calling the
ColorTemperature set handler once a minute. That is one Zigbee command per minute, and it goes
through the same coalescing and throttling as any other write. MANUAL mode would push the
transition onto the bulb itself, but it means re-implementing the transition curve, its
brightness adjustment and its notification thresholds by hand — a poor trade for one command a
minute.

Note that Adaptive Lighting moves **colour temperature only**. Choosing a colour in the Home app
switches it off, which is HomeKit's own behaviour.

## Firmware: pin the version, do not chase the newest

**With `adapter: zoh`, the RCP firmware must match zigbee-on-host's era.** zigbee-on-host 0.2.4
was published in December 2025 and has not been released since.

| Firmware | Result |
| --- | --- |
| `SL-OPENTHREAD/3.0.2.0` (Nerivec `v2025.12.3-pre1`) | works |
| `SL-OPENTHREAD/3.1.1.0` (Nerivec `v2026.6.1-pre1`) | **broken** — transmits die ~12s after start, then the radio stops answering entirely |

Newer is worse here, which is the opposite of the usual instinct. Swapping RCP firmware needs no
re-pairing: zoh keeps the whole network host-side in `zoh.save`, with a host-assigned EUI64.

## Recovering a wedged coordinator

An OT-RCP coordinator can stop responding — no reply even to a raw Spinel probe. The plugin
reports `SPINEL[tid=1] Timeout` and then retries with backoff, so it recovers on its own **once
the radio does**, but the radio itself needs a nudge:

```bash
pipx run universal-silabs-flasher --device /dev/ttyACM0 \
  --bootloader-reset baudrate probe
```

That resets the radio chip, relaunches its firmware and prints the version. Stop Homebridge
first so the port is free.

**A USB re-enumeration is not enough** (`echo 0 > /sys/bus/usb/devices/*/authorized`, then `1`):
the ZBT-2's USB bridge re-enumerates happily while the radio behind it stays dead. Only the
bootloader reset revives it.

## Running in Docker

The container needs the device passed through. In `docker-compose.yml`:

```yaml
services:
  homebridge:
    devices:
      - /dev/serial/by-id/usb-Nabu_Casa_ZBT-2_XXXXXXXX-if00:/dev/ttyACM0
    # If Homebridge does not run as root in your image, it also needs the
    # dialout group — use the gid from `getent group dialout` on the host.
    # group_add: ["20"]
```

## Troubleshooting

```bash
ZIGBEE_PORT=/dev/serial/by-id/usb-... pnpm diagnose
```

Stop Homebridge first. This prints the coordinator's firmware, every paired device's IEEE address
(the value for per-device settings), each endpoint's clusters, and the capabilities the plugin
derives from them — so a light exposed as the wrong kind of accessory can be traced to the
cluster that decided it.

**A light shows "No Response".** Either nothing has been heard from it yet, or it has stopped
answering. This is deliberate: showing "Off" for a device that has not answered is a confident
wrong answer, and "No Response" is visibly an absence of one.

After three unanswered attempts the plugin says so in the log, once, and stops spending radio on
that device. That matters because the adapter runs one transaction at a time: every send to an
absent device holds the radio for a ten-second timeout, and everything else in the house waits
behind it. A lamp on a switched-off relay with Adaptive Lighting enabled would otherwise produce
a failed send every minute, all night.

Three things still happen for a device in that state, and each is a way back:

- **Tapping its tile still reaches the radio.** A press is the best probe there is, and if the
  lamp has power again it answers at once — no waiting for the next poll.
- **It is still polled, on a widening schedule**: the next cycle, then every second, fourth and
  eighth. A device whose reporting configuration did not survive its power cycle will never speak
  first, so the plugin has to keep asking.
- **Anything heard from it ends the outage immediately**, including an unsolicited report or an
  announce after a power cycle.

Only what the *automations* send — Adaptive Lighting's minute-by-minute colour temperature — is
dropped, and only until the device is heard from again. A device that *answers* and refuses a
command is unaffected: only silence counts.

Adaptive Lighting also costs nothing at all for a light that is simply switched off. The colour
temperature is held and applied by the command that next turns the light on, which is where it
was going to be needed anyway.

**A light changed at the wall does not update in HomeKit.** Its attribute reporting did not take.
The plugin re-arms reporting whenever a device re-announces itself, so power-cycling the bulb
usually fixes it; the periodic refresh (`refreshInterval`) covers it meanwhile.

## Status

Lights and outlets. Switches, sensors and buttons are not implemented yet — the cluster-driven
design makes each one a capability plus an accessory file, so they are additive.

The `zoh` stack is young. Its author describes live-network use as pending, and it implements no
Touchlink and no InterPAN. If you want the long-established path instead, flash the Zigbee NCP
firmware for your stick and set `adapter` to `ember`.

## License

MIT
