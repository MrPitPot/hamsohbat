# Project status

**Version 1.6.0** — https://github.com/MrPitPot/hamsohbat

## Latest
- Server relay fallback (src/relay.ts + Hub binary forwarding): when two people cannot connect peer-to-peer, audio, camera and screen share are recorded (MediaRecorder), forwarded by the Hub and played via MediaSource. No TURN key / card needed.
- Music player and bot ideas removed (cancelled by the owner).
- Auto input sensitivity, extra-strong noise cancellation, TeamSpeak click-to-join and channel quality, retuned sounds.

## Tests (last run, all green)
ui 66 · voice 55 (includes relay audio/camera/screen) · desktop-ui 35 · teamspeak 40 · api 171 · features 96

## Known
- Relay mode uses more server requests/bandwidth; fine for small groups.
- Real-exe installer test is sensitive to an existing install on the machine.
