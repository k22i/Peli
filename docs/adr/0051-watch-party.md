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

## Addendum (2026-11-21): reactions, and a party that docks beside the video

Two additions, neither of them a change to the party above: emoji reactions, and a "Keep open" mode that turns the player's party sheet into a sidebar.

### Reactions ride the party channel, Peli-only

A reaction is one broadcast event on the party's private channel, `"reaction"`, with `{emoji, member_id, sent_at}`. There is no `watch_party_*` function for it and no new RPC: the channel already carries `state`, `status` and `chat`, and a reaction is the same kind of traffic. **Nuvio's clients ignore a broadcast event they don't know**, so this one reaches Peli members only: a friend on Nuvio's own apps neither sees a reaction nor sends one, and nothing breaks for them. That asymmetry is the price of not asking Nuvio for a backend change.

**One set of eight, in one order:** 😂 ❤️ 🔥 😮 😢 👏 🎉 🍿 (`REACTIONS` in `internal/party/reaction.go`, and again in `lib/party.ts` for the buttons). The emoji is the whole payload: an emoji outside the list is refused on the way out (`CodeInvalid`, and `CodeNotInParty` with no party) and dropped silently on the way in, so a member on a doctored client can't paint the others' screen with arbitrary glyphs.

**At most one reaction every 250 ms per member**, counted on both ends: `SendReaction` drops the ones in between and returns nil rather than an error (a mashed button is not a mistake), and the incoming `"reaction"` case keeps the same window per sender, so one client's flood can't be multiplied by the others. It is the only party traffic Peli rate-limits itself; chat's is Nuvio's (`rate_limited`), and playback state has none.

**The sender's own reaction is emitted in Go.** The channel is joined with `self:false`, since a member already knows what it sent, so a broadcast never comes back to its sender. `SendReaction` therefore emits `party:reaction` itself, with `mine: true`, next to the broadcast for everyone else, and `session.go`'s broadcast switch gained a `"reaction"` case that does the same for another member (`mine` false, or true for this device's seat when a broadcast is replayed). **The UI never bursts on the click, only from the event**: the sender and everyone else take one path, and a refused emoji or no party means no confetti.

`EventReaction = "party:reaction"` carries `Reaction{Emoji, MemberID, Name, Mine, At}` (`types.go`, JSON `emoji`, `memberId`, `name`, `mine`, `at`). The name is resolved from the session, so the burst's quiet label can say whose it was without the frontend looking a member up.

On the screen: `lib/confetti.ts` holds the pure physics, `components/party/emoji-confetti.tsx` the one overlay with a module-level `burst(emoji)` that drives whichever overlay is mounted (a no-op when none is), `components/party/reaction-bar.tsx` the eight buttons (`ReactionBar`) and `PartyReactionLayer`, which mounts the overlay, bursts from `usePartyReactions` and shows the name. `lib/party.ts` has `REACTIONS`, `reactionEvent`, `useSendReaction` and `usePartyReactions`.

### The dock: the party panel beside the video

W's sheet dims the video behind it, which is wrong for a party you are watching. **"Keep open"** turns the panel into a sidebar on the right: no backdrop, no dimming, the members and the chat stay usable while you use the player, and the video shifts left so the sidebar never covers the picture.

- **Per device, not per profile:** `partyDock` in `DeviceSettings`, persisted with the other device settings. A docked sidebar on the desktop says nothing about the iPhone.
- **Desktop and iPad only.** `usePartyDock()` reports `available: false` on the compact shell, and `docked: false` with it, so the iPhone keeps ADR-0063's bottom sheet and hides the option altogether.
- **The shift is mpv's, not the webview's.** `Player.SetVideoInset(rightPx)` sets mpv's `video-margin-ratio-right`, computed from the window width and recomputed on resize, so the picture is resized inside mpv's own viewport instead of being covered by a layer. It is **ungated**, like `Direct` and for the same reason: it moves the picture, it doesn't touch playback, so a member changing it must not publish anything or be refused by the host. It exists on the desktop player and in `service_ios.go`, and it is bound.
- **`--party-dock-w`** (`22rem` while docked and open, `0` otherwise) is set on the player root. `components/party/party-dock.tsx` exports `partyDockWidth`, `usePartyDock()` and `PartyDock({ onClose })`, which fills its container's height while the player page positions it. **Undock** (`setDocked(false)`) leaves the party open and shows the sheet instead; `onClose` hides the panel and keeps the setting, so W puts it back.

### Not done here

- Reactions stay invisible to members on Nuvio's own clients, by construction. Nuvio gaining a reaction of its own would mean reading their payload, not ours.
- The dock has not been seen on a device: resizing an iPad window, and the picture's margin against libmpv's own aspect handling, are a run that hasn't happened.
