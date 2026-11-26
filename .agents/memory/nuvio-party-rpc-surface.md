---
name: nuvio-party-rpc-surface
description: Live api.nuvio.tv PostgREST party RPC list (probed 2026-11-26): no account-scoped party listing exists; plus two RPCs Peli hasn't implemented (link_profile, topic_allowed)
metadata:
  type: project
---

Probed live `https://api.nuvio.tv/rest/v1/` OpenAPI (needs the publishable key as `Apikey` **and** a bearer access token from the password grant; the OpenAPI 401s without the Apikey header). Read-only, no writes.

The complete party RPC surface:

- `watch_party_clock`, `watch_party_enabled`
- `watch_party_create`, `watch_party_preview`, `watch_party_join`
- `watch_party_heartbeat`, `watch_party_update`, `watch_party_end`, `watch_party_leave`
- `watch_party_set_host_only`, `watch_party_remove_member`
- `watch_party_send_message`, `watch_party_list_messages`
- `watch_party_link_profile` (params: `p_device_id`, `p_profile_index`, optional `p_member_id`) — **not implemented in Peli**
- `watch_party_topic_allowed` (param: `p_topic`) — **not implemented in Peli**

**Why:** the user asked whether a different profile on the same account could see ongoing parties and join in one click (no code).

**How to apply:**
- There is **no** RPC to list/enumerate a party for an account, and `watch_party_join` has `p_code` as a required param — so same-account cross-profile discovery is impossible against the current backend without either a Nuvio change or a Peli-side side channel. A task doing this needs to say which path it takes.
- `watch_party_join` also takes `p_profile_index` (optional), plus `p_avatar_url`/`p_avatar_color`/`p_display_name`/`p_device_id`.
- **Account-wide channel ruled out (spike 2026-11-26, `spikes/party-account-topic/REPORT.md`).** `watch_party_topic_allowed(p_topic)` takes the bare name (no `realtime:`) and answers a boolean: `false` for every `account:`/`user:`/`peli:`/`profile:`/`parties:` spelling, and the socket refuses them with `Unauthorized`. `private:false` gets `PrivateOnly`. Only an existing party's `watch-party:<id>` is allowed, and a second session on the same account joins it with **no seat** and sees presence + broadcasts, but nothing can discover the id. One-click same-account join therefore needs a non-Nuvio route (LAN discovery, or storing the code in synced data) or a change on Nuvio's side. Cross-account isolation of the party topic is untested (no second account).
- Related: [[watch-party]], [[nuvio-live-account]].
