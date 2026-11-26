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
- A guest whose party moves to the show's next episode gets "Play it" (the next-episode card's pick); anything else is "Watch with the party", which opens the picker. **Superseded in part by the 2026-11-22 addendum below:** "Play it" opens the party's picker now and picks from the host's stream there, and a guest gets no next-episode card at all, since nothing here gets that episode ready.

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

## Addendum (2026-11-22): guests don't choose a stream

A party is only worth watching if everyone has the same cut in front of them, and the guest's own picker is how that stops: they join on something the host isn't playing, or the host switches and they stay on the copy they chose. So the host keeps the picker and the switcher exactly as they were, and **a guest never chooses**. Peli picks for them, from the host's stream: on joining, when the party moves on, and every time the host switches partway through. One chooser does all three, `frontend/src/lib/party-pick.ts`, and nothing else picks for a guest.

### The rule: four steps, then resolve

The order is `partyPlan`'s, which `orderForParty` hands out:

1. **The guest's own stream that is the host's**, by `matchesPartySource` (`lib/party.ts`): the same torrent and file, or else the same file name. Exact, and the pick everyone wants.
2. **The host's shared link** (`party.shared`), when the host shares it. It isn't a candidate, since its link plays as it is, so it sits between the exact match and the rest.
3. **The closest of the guest's own streams to the host's source**: the host's name and filename through `lib/ranking`'s `parseStream`, preferring the same resolution, then the same source (WEB-DL, BluRay…) or release group, then the nearest size. Ties keep the ranking's order.
4. **The guest's top ranked pick**, when nothing is alike, or the host's source is unknown, or no addon has a copy of it.

The last two are one list: the guest's remaining streams nearest the host's first, and the reason is `closest` only when the first of them has something in common with the host's stream (its resolution, its source or its group); otherwise the pick is the guest's own top pick and the reason is `top`. The reason is only what the UI and a test read.

The steps are then tried through `resolvePick` (`lib/resolve.ts`) in that order, each candidate's own copies (its alternates) tried in turn, one at a time because each resolve can make a debrid service start a download, and the first that opens starts at `Party.StartAt(media)`, so the guest lands where the party is. The candidates are the *unfiltered* ranking, top pick first: a guest's own filter chips never change the party's pick.

**An auto-pick is the party's, not the guest's habit.** It never calls `SetChosenSource`, so the source the guest remembered for a show stays theirs, and it never pre-resolves (`usePreResolve` is off for a guest, ADR-0060): nothing is resolved ahead of the pick that actually plays.

### When it picks: the wait rule

**A copy of the host's stream is worth no wait**: as soon as one of the guest's streams is the host's, the chooser starts, however many addons are still answering. Anything else waits for the whole list, because the closest stream is only as good as the streams that have answered: it starts once every addon has answered, or ten seconds after the first answer (`waitAfterFirst`), whichever comes first, and then takes the best of what it has. The clock starts on the first answer, not on the mount, so an addon that never answers can't hold a guest forever.

The start waits for the ranking as well as the answers. Streams reach the ranking a step after they reach the picker — the feed is an effect, and the engine answers a microtask later — so for a render or two a source can have streams the ranked view doesn't hold yet; starting then would pick from an empty list and fail the guest for nothing. The one case that doesn't wait is nothing handed on at all (no addon has streams, or none it can play), which is a real failure and is answered by the deadline above.

A failure is the picker's to show, with **Try again** (`retry()` runs the chooser again from the top, against the party's source as it is then); in the player, the follower's prompt says so instead.

### The guest follows the switch, always

**The host switching streams is another pick, not a new choice for the guest.** `NoticeSource = "source"` (`internal/party/types.go`) is a notice, not a new media: the party's media key is the same and only its `Source` moved. `session.go`'s `applyMedia` emits it for that case to every guest, carrying the party's `Media` with the new source; the host's own device gets none, since it made the switch. Every other notice kind is unchanged.

`player-page.tsx` takes the notice as `following` and mounts `PartyFollower`, keyed on the source so a second switch starts over, and enabled only once the party's state carries it (`arrived`) because the state can trail the notice. That runs the same chooser against the new source with `open: false`, which returns the pick and its `Source` instead of loading them, and the player loads it from where this guest is — the `Snapshot`, or where it stopped after a failure — not from the party's position: a stream change is a change of file, not of place in the episode.

**Nothing keeps the old stream.** A guest's old copy may rank higher for them, and it is still not theirs to keep: the chooser runs from the host's new source and the guest switches to whatever it lands on. The one quiet case is `sameStream`: when the chooser lands on the stream already playing — what a switch back to it gives — nothing resolves and nothing loads, the cycle ends as `same` and the prompt goes without a word. Because that check sits inside the step loop, a switch can also arrive there the long way: once the other candidates fail to open, the stream already playing is what's left, which ends the same quiet way instead of as a failure.

While it works the player says `{host} switched streams: switching too…`. If nothing opens, the guest plays on with the old stream and the prompt becomes `Couldn’t switch to {host}’s new stream`, with **Try again** to run the chooser again. There is never a list to fall back on, and the mini player shows none of it. Only the latest switch counts: each pick carries an `AbortSignal`, the hook restarts — aborting the resolve in flight — whenever the party's source changes, and the player aborts its own load too, so a stale pick never plays.

### The Update behind it: the same media, a new source

The host's side is `playback.go`'s `followPlayer`, in its same-media branch: it compares `streamSig` — the shared link and the `Media`'s `Source` — and publishes through `publishMedia` when that changed, which sends the backend `Update` with the party's media key and the new source. Sharing isn't part of it: `SetSharing` decides whether the link itself goes to the channel, not whether the party's source moves, so a host who never shares still moves everyone. A file that fails and a link that expires and is reloaded arrive as a new `Watch` with a new `Source`, so both move the party the same way, and a tick without a switch publishes nothing. `TestHostSwitchPublishesSource` covers sharing and not sharing; `TestGuestFollowsSourceChange` covers the guest's notice, and its absence for a source that didn't change.

### What a guest loses: no list, no switcher, no S

- **The Streams button and the sheet are the host's.** `isPartyGuest(party, media)` (pure, so no mock) drops the button, the `StreamSwitcher` isn't mounted at all, and `openSwitcher` returns at once, so nothing opens the panel for a guest — the button, S, and the failure overlay all went through it.
- **No S.** `s` is out of `onKey`'s `once` map, `shortcuts.tsx`'s `playerShortcuts` became `playerShortcuts({ guest })` and drops the S row with its "In the Streams panel" group, and the ⌘K palette has no stream command, so there was nothing there to take away.
- **The failure overlay sends them to the party.** Its second button reads "Try another stream" for a guest and calls `useWatchWithParty()(party.media, true)`: the party's picker route, which picks from the host's stream and starts where the party is. The host's still opens the sheet, or leaves when there is nothing to switch to.
- **The guest's picker is a status, never a list.** `GuestPick` in `streams-page.tsx` replaces the whole page for a guest — no summary, no filter chips, no jump strip, not even the no-addons notice — and P plays nothing. It says `Finding {host}’s stream…`, then `Opening…`, and on failure `Couldn’t open a stream like {host}’s` with "None of your addons opened the party’s stream. Try again, or leave the party and pick one of your own.", **Try again** and **Back**. While it works it says "Peli plays the party’s stream, so you see exactly what they do." `data-slot="party-pick"` names that status alone, so a test or a tool reads it without the page's own Back.
- **`PartySources` is the host's card.** The picker's "Your watch party is watching this" sits after the guest's early return, so only a host reads it.
- **Every entry point goes to the party's picker route.** `usePlay` (`lib/playback.ts`) and `useOpenTitle` (`lib/title.ts`) ask `usePartyGuestMedia`, and for the party's own film or episode they call `useWatchWithParty()(party.media)` instead: Play on a title page, a title menu's Play, opening that title from a card or a row.
- **"Play it" no longer uses `usePreparedNext`'s pick.** `player-page.tsx`'s `partyNext`/`startNext` use the party's own test, `party && !party.isHost`, because `isPartyGuest` asks whether the party is on the file *playing* and here it is on the next one; the `NextEpisode` card isn't drawn while the party is on the next episode, so nothing prepares this device's pick for it, and Play it — or the end of the file with "Still watching" — opens the party's picker for that episode instead.

### Not done here

- Whether Nuvio's own clients act on a same-key `Update`: untested. Peli sends it as Nuvio's clients send their own media, but Nuvio's apps may only read an `Update` that changes the media key, in which case a friend on Nuvio's apps keeps playing their own stream through a host's switch and sees no notice either.
- No real two-device run of any of this, no host on a Nuvio app, and no live host switch. Everything above is the tests' and one device's reading of the code.

## Addendum (2026-11-26): guests choose their own stream again

The addendum above is reversed. Everyone in a party — host or guest — picks their own stream from their own addons, exactly as they did before 2026-11-22: the same picker, the same switcher with its **S**, the same failure overlay's "Choose another stream". Every way into the party's media (Play, opening the title, "Play it" on the next episode) keeps its normal flow, and a guest's next-episode card prepares their own pick again.

`NoticeSource` is gone from Go along with `streamSig` and the same-media branch of `followPlayer`: a host switching streams on the same media is their own business now, and the party's `Source` stops moving with the switch. `lib/party-pick.ts` (the chooser, `usePartyAutoPick`, `isPartyGuest`) is deleted.

**Why: "Share my stream" already covers the one thing the follow bought.** A host who wants guests on their exact link shares it — that's the opt-in, and it was always the *better* answer, since a followed source still sent each guest to their own addons and their own debrid. The follow, meanwhile, took the guest's streams away from them: no list, no S, no switcher, and a host's switch yanked everyone's file out from under them.

What stays exactly as it was:

- **"Share my stream"**: unchanged (`publishMedia`'s `Source == nil` guard is back to its pre-follow reading, so the host's initial pick still publishes the party's source).
- **The party moving to another title or episode** (`publishMedia` on a media-key change) — unchanged; that's the party, not the stream.
- **Playback sync** (pause, seek, rate, waiting for stragglers) — unchanged.
- **The guest's pick starting where the party is** (`Party.StartAt` in the picker) — unchanged.
