# Project status

**Version 1.5.0** — deployed to Cloudflare, installed locally, published at https://github.com/MrPitPot/hamsohbat

## Done in 1.5.0
- TeamSpeak: single click joins a channel; admins can set channel voice quality.
- Calls: public TURN relay fallback + "can't connect directly" hint (add own TURN key for reliability, see README).
- Input sensitivity: automatic (noise-floor tracking) + manual, for Hamsohbat and TeamSpeak. Extra-strong two-stage noise cancellation.
- Interface sounds and soundboard re-tuned lower and warmer.
- Music in voice channels (YouTube links / audio files, shared synced queue).

## Tests (last run, all green)
ui 70 · desktop-ui 35 · teamspeak 40 · voice 50 · (api 171 / features 96 unchanged)

## Remaining / known
- Create a Cloudflare TURN key (Realtime → TURN) and set TURN_KEY_ID / TURN_KEY_API_TOKEN for reliable calls behind strict NATs.
- Real-exe installer test is sensitive to an existing install on the machine.
- Discord bots cannot be connected (they live on Discord); the built-in music player replaces a music bot.
