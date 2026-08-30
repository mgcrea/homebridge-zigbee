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
  "baudRate": 460800,
  "rtscts": true,
  "channel": 15
}
```

Every other option has a working default; see `config.schema.json` for the full list.

`channel` is worth a thought. Zigbee shares the 2.4GHz band with Wi-Fi, and channels 15, 20 and
25 sit in the gaps between Wi-Fi 1, 6 and 11. **Changing it after devices are paired strands
them.**

## Pairing

Turn on the **Zigbee Pairing** switch in the Home app, then put the device into pairing mode. The
switch turns itself off when the window closes. With Homebridge stopped you can do the same from
a terminal:

```bash
ZIGBEE_PORT=/dev/serial/by-id/usb-Nabu_Casa_ZBT-2_XXXX-if00 pnpm pair 120
```

### Hue bulbs must be factory reset first

A bulb currently paired to a Hue bridge will not join. Remove it in the Hue app, or power-cycle
it five times. The `zoh` stack does not implement Touchlink, so there is no over-the-air way to
take a bulb off its old bridge — that is a real limitation, not a missing setting.

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

**A light shows "No Response".** Nothing has been heard from it yet. This is deliberate: showing
"Off" for a device that has not answered is a confident wrong answer, and "No Response" is
visibly an absence of one.

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
