---
status: accepted
date: 2026-11-11
---

# Watch party: Nuvio's own parties, run from Go, the player kept in step through a gate

Nuvio's apps (Android TV, mobile, desktop, webOS/Tizen) have watch parties: a host starts one from the player, friends join with a six-character code, and everyone plays the same film or episode from their own streams, in step. Peli joins the same parties, so a Peli user can watch with friends on any Nuvio app, and the other way round.

## What a party is, on the wire

Read from Nuvio's clients (GPL-3, so re-implemented, nothing copied) and checked on api.nuvio.tv on 2026-11-11 (`TestLiveParty`, `TestLiveTwoMembers`). Self-host has none of it.

- **The backend keeps the party** through `watch_party_*` functions: `create`, `join` (also takes a device's seat back), `preview`, `heartbeat` (every 2 min), `update` (the host's media; anyone's last playback, for later joiners), `leave`, `end`, `set_host_only`, `remove_member`, `send_message`, `list_messages`, `clock` (server time in ms) and `enabled` (no session). A refusal is a 200 with `{"error": "party_not_found" | "party_full" | "party_ended" | "removed" | "not_member" | "not_host" | "rate_limited" | "unavailable"}`. `update`, `leave` and `end` answer only `{"ok": true}`. Live parties have 8 seats. The discovery document says `capabilities.watch_party`.
- **The members talk on a private Realtime channel**, `watch-party:<party id>`, joined with the session's token and the member id as presence key. Live answers `410 Gone` on `/realtime/v1/websocket` unless the query has `nuvio_realtime=1`, as Nuvio's apps send. Members broadcast `state` (playback), `state_request`, `status` (loading, buffering, ready, behind, browsing; also tracked as presence) and `stream` (the host's shared link). The backend broadcasts `member_joined`, `member_left` (with the new host), `control` (host only), `media` (the party moved on), `chat` and `ended`.
- **Playback** is `{seq, member_id, paused, position_ms, rate, at, media_key, waiting}` on the server's clock: where the party is, at server time `at`. Higher `seq` wins, a tie goes to the higher member id. A media key is `type|id|season|episode`.

## Decisions

**Go runs the party, not the webview** (`internal/party`). Tokens stay in Go (ADR-0008), and the sync loop has to run four times a second against mpv's real position, which a throttled or hidden webview can't promise. The Realtime client is a small Phoenix channel client in `internal/nuvio/realtime.go` (coder/websocket, already in the module graph through Wails): join, heartbeats with a dead-socket check, a fresh token pushed every 4 min, rejoin with backoff from 1 s to 30 s. `internal/backend.Parties` wraps the functions with the session and aliases the types, so `internal/nuvio` is still imported only by account and backend.

**Peli follows Nuvio's rules exactly** (`rules.go`), since one party mixes clients: drift past 250 ms is nudged by playing 5 % faster or slower until it's under 80 ms; past 1.5 s it seeks, adding a lead learned from how late the last seek landed; paused, 500 ms off seeks. The coordinator (the host while online, else the first member online, but only the host in a host-only party) pauses the party with `waiting` while anyone watching is loading or buffering, and resumes once they're ready or after 15 s, then stops waiting for them until they're ready again. The server clock is sampled at join and four more times; the sample with the shortest round trip anchors it.

**The player has a gate** (`player.GateWith`): the user's pause, seek, seek-by, speed and scrub ask the party first. In step with the party, they're published; in a host-only party a guest's pause or seek back is theirs alone (they watch "behind", and the others see how far behind, rounded to 5 s), a seek forward while behind catches up, and anything else is refused with "Only the host can control playback". The party's own corrections go through `player.Direct`, which skips the gate. OS media keys use the gated methods, so they're published too. The gate is a separate type (`party.GateOf`) so Wails doesn't bind its methods for the webview.

**The frontend says what plays** (`Party.Watch(media, stream)`) from the player screen, and nothing on leaving it (`Watch(null)`), from `PlayerPage`, not each file: the next episode or another stream, as a new file of the same screen, moves the party when the host's previous file was the party's. A host who opens another title from browsing moves it only with "Switch the party to this", as in Nuvio. The last member watching who leaves pauses the party where they stopped.

**Joining is by code, not by deep link.** The invite is the code and Nuvio's `https://nuvio.tv/party/<code>` link, which opens Nuvio's apps; Peli has no URL scheme yet, so a Peli friend types the code on `/party` (profile menu, ⌘K, or the player's sheet with W). The picker opened for the party's media offers "Play the party's source" (the user's stream with the host's torrent and file, or file name) and, when the host shares it, "Play Ana's stream" (the host's own link, which can carry their debrid key: off by default, and never a torrent's loopback link). Whatever is picked starts at the party's position (`Party.StartAt`).

**Who may join:** a profile linked to the signed-in Nuvio account, never the Guest, never a kids profile (a party plays whatever the host picks). Switching profile or signing out leaves the party. The device is known by a persistent install id (`Store.DeviceID`), so restarting Peli takes its own seat back instead of a second one.

## Consequences

- Parties work only on Nuvio's hosted backend: self-host has neither the functions nor the flag. The contract test lists the functions in `liveOnly`, checked by the opt-in `PELI_NUVIO_LIVE_WRITES=1 go test -run 'TestLiveParty|TestLiveTwoMembers' ./internal/nuvio/ ./internal/party/`, which ends its party and signs out.
- Parties use Nuvio's backend for something new for a third-party client: a websocket per party member and a heartbeat every 2 minutes. Worth mentioning when Nuvio is asked about the hosted backend (#93).
- Members match the host's source by torrent and file or by file name only; Nuvio's last resort (the same name from the same addon id) needs manifest ids Peli doesn't carry with a stream yet.
- A guest whose party moves to the show's next episode gets "Play it" (the next-episode card's pick); anything else is "Watch with the party", which opens the picker.

## Not done

- A `peli://party/<code>` link, and opening Nuvio's https link in Peli.
- Nuvio's "companion" mode (a second device in the same seat, for chat).
- Trying it in a party with Nuvio's own apps: the live tests use two Peli members on one account. Their payloads are the shapes Nuvio's clients read and send, but no Nuvio app took part.
