# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0](https://github.com/mgcrea/homebridge-zigbee/compare/v0.1.3...v0.2.0) (2026-09-03)

No accessory is re-registered by this release: rooms, names and automations are preserved.

### Bug Fixes

- **safety:** the network reset guard works. It could never fire — herdsman clears the device database inside `start()` on a reset, before anything can look, so the count the guard was given was always zero and the README's headline safety property was dead code. The count now comes from the database file, read before the controller is built. There is also a pre-flight refusal that fires before the radio is touched at all: with devices paired and `zoh.save` gone, the next start would form a new network and orphan every one of them. A refusal writes a marker, so the restart afterwards — which looks healthy from every other angle, because `zoh.save` now matches and the database is empty — keeps refusing rather than quietly handing back an empty network.
- **lifecycle:** a failed start always releases the serial port. It leaked three different ways: `Controller.stop()` returns early when `adapter.start()` never succeeded, throws inside its unguarded `backup()` when it did, and on `zoh` does not close the port even when it runs to completion — only `closePort()` does. Every retry then lost to "Cannot lock port" against the plugin's own handle, which is exactly what the retry loop exists to prevent.
- **lifecycle:** a bug in the plugin no longer looks like a bad radio. A throw out of the platform's setup used to close a perfectly healthy controller and reopen it in a loop, with the backoff reset on every pass.
- **discovery:** an interrupted pass no longer unregisters accessories. It checked for shutdown once, at entry, so a reconnect or a shutdown halfway through finished by removing every accessory it had not reached yet — and with them the rooms and scenes assigned by hand, permanently.
- **light:** brightness 0 turns the light off. `moveToLevelWithOnOff` at level 0 switches the lamp off, but the plugin recorded it as on — so "set the lamp to 0%" left a tile showing a light that was on and dark. A batch that also asked for `on` is floored at level 1 instead, which is what "on, as dim as it goes" means.
- **light:** switching from a colour to a colour temperature no longer flashes the old colour back into the Home app. Recording the new colour mode made the state listener recompute hue and saturation from the xy pair the lamp held *before* the change.
- **light:** a brightness write no longer cancels an `On = false` from the same 50ms window.
- **light:** the colour temperature read is gated on the lamp's colour mode, like the other two paths already were. A lamp in xy mode answers with whatever it held when it was last in colour-temperature mode, so a blue lamp read as cool white.
- **light:** a light that was unreachable when it was first discovered gains its colour controls when it comes back, rather than keeping its on/off skeleton until the next Homebridge restart.
- **config:** one empty per-device row no longer takes the platform down. The Config UI writes an empty object into the list the moment *Add* is pressed, the whole-list parse failed on it, and the platform went dormant — every light in the house unresponsive over a row nobody had filled in yet. Bad rows are now dropped with a warning naming the row and the field.
- **config:** `baudRate` and `rtscts` default to unset, so zigbee-herdsman's per-adapter detection decides. Defaulting them to a ZBT-2's settings meant a ConBee or a Z-Stack stick simply would not open.
- **config:** `ezsp` appears in the settings UI. It was accepted by the plugin and missing from the schema, and the Config UI blanks a field whose value is not in its list — so opening the settings page once silently unset the adapter of anyone using it.
- **identity:** the coordinator EUI64 is validated properly. `zoh`'s failure mode for an unparsable one is silent: it falls back to a hard-coded constant that every install of it shares, so two coordinators in range would claim the same IEEE address — the exact thing the identity file exists to prevent.
- **pairing:** the pairing switch reports a failure to HomeKit instead of always looking as though it worked.
- **logging:** herdsman's "Coordinator address changed" and channel-mismatch lines reach the log rather than being demoted to debug with the rest of its per-frame chatter.

### Performance

- **adaptive lighting:** a light that is off costs no radio at all. hap-nodejs never checks `On` before calling the colour-temperature handler, so the schedule drove a command a minute into dark lamps — and into a lamp switched off at a relay, that was a ten-second timeout the whole house queued behind. The value is held and folded into whichever command next turns the light on, where it was going to be needed anyway.
- **reachability:** a tap on the tile always reaches the radio. The outage guard used to decline every write, so a lamp whose power had come back stayed dead in the Home app until the next poll — the opposite of what the guard was for. Only the automated writes are dropped now; a press is the best probe there is.
- **reachability:** a silent device is probed on a doubling schedule — the next cycle, then every second, fourth and eighth — instead of costing a ten-second timeout every cycle for as long as it stays dark. Anything heard from it collapses the schedule back at once.
- **discovery:** a rediscovery of a device already adopted costs nothing. Every pass used to re-read two descriptions per endpoint on top of the binds, so a reconnect put the house behind a minute of round trips it already had the answers to. The part that costs radio is now cached with the accessory and carried across restarts.
- **discovery:** battery devices are no longer bound, reported on or polled, and devices whose interview has not finished are left for the next pass.
- **discovery:** a device that announces itself several times on power-up, as Hue bulbs do, is re-armed once rather than once per announce. A refresh cycle that has not finished is no longer overtaken by the next one.
- **reporting:** the reportable change on brightness and colour temperature is wide enough that a fade no longer means a report per second per light.

### Internals

- The state directory is `0700`. `zoh` writes `zoh.save` — which holds the network key, the trust centre key and the frame counters — as `0644` and offers no hook to change that, so the directory is the enforcement point.
- Every voided promise has a `.catch`. A rejection out of any of them took Homebridge down, and every other plugin with it.
- The four scripts share the plugin's own controller options rather than each re-deriving them, which is how `concurrent: 1` came to be set in the plugin and missing from `diagnose` and `control`.
- Test count roughly doubles, with new suites for the platform, the config schema, the pairing switch and the backoff.
