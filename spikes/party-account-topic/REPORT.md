# Spike: one realtime channel per Nuvio account?

Can Peli announce a running watch party to the other profiles of the same Nuvio
account over Nuvio's realtime websocket, so a profile's Join page could list the
account's live parties and join with one click, no code to share?

Probed live against `https://api.nuvio.tv` on the user's real account with two
separate password-grant sessions of that account (**A** and **B**, standing in
for two devices or profiles). Raw output: [`results/run.txt`](results/run.txt),
plus [`results/run-round2.txt`](results/run-round2.txt) from an earlier pass that
found the `realtime:` prefix rule. Everything is redacted: email, user UUID,
tokens, party id and code.

## Verdict

**Doesn't work.** Nuvio authorizes no account-scoped channel: `watch_party_topic_allowed`
says `false` for every account-ish topic (`account:`, `user:`, `peli:`,
`profile:`), and the websocket refuses those joins with
`Unauthorized: You do not have permissions to read from this Channel topic: …`.
The only topic a session may join is an existing party's own topic,
`watch-party:<id>`, whose id nothing on the account can discover.

## Per-topic result

`topic_allowed` was asked from A and from B; the answers were identical in every
row. Joins use the socket topic `realtime:` + the name below, `private: true`
(Peli's frame). "n/a" means there was nothing to test the columns against: no
session got into that topic, so no broadcast or presence could be sent or
received — the exact refusal for each is under "Exact frames and errors".

| topic asked about | `topic_allowed` A / B | A join | B join | broadcast A→B | presence A→B | late-join presence |
|---|---|---|---|---|---|---|
| `watch-party:<party-id>` (a party A created) | `true` / `true` | **ok** | **ok**, no `watch_party_join`, no seat | **yes** | **yes** (in B's `presence_state`) | **yes**, A in B's initial `presence_state` |
| `watch-party:<random uuid>` | `false` / `false` | refused: `Unauthorized` | refused: `Unauthorized` | n/a | n/a | n/a |
| `account:<user-uuid>` | `false` / `false` | refused: `Unauthorized` | refused: `Unauthorized` | n/a | n/a | n/a |
| `user:<user-uuid>` | `false` / `false` | refused: `Unauthorized` | refused: `Unauthorized` | n/a | n/a | n/a |
| `peli:<user-uuid>` | `false` / `false` | refused: `Unauthorized` | refused: `Unauthorized` | n/a | n/a | n/a |
| `profile:<user-uuid>:1` | `false` / `false` | refused: `Unauthorized` | refused: `Unauthorized` | n/a | n/a | n/a |
| `account:<user-uuid>:parties` | `false` / `false` | refused: `Unauthorized` | refused: `Unauthorized` | n/a | n/a | n/a |
| `parties:<user-uuid>` | `false` / `false` | refused: `Unauthorized` | refused: `Unauthorized` | n/a | n/a | n/a |
| `watch-parties:<user-uuid>` | `false` / `false` | refused: `Unauthorized` | refused: `Unauthorized` | n/a | n/a | n/a |
| `peli:parties:<user-uuid>` | `false` / `false` | refused: `Unauthorized` | refused: `Unauthorized` | n/a | n/a | n/a |

Two more spellings that matter:

| asked about | outcome |
|---|---|
| `realtime:watch-party:<party-id>` to `topic_allowed` | `false` — the function wants the **logical** name, the socket wants the **prefixed** one |
| joining the socket topic `watch-party:<party-id>` (no `realtime:` prefix) | `phx_reply error {"reason":"unmatched topic"}` |

## Exact frames and errors

`watch_party_topic_allowed`'s signature, from PostgREST's own hint when sent a
parameter it doesn't have:

```
{"code":"PGRST202","details":"Searched for the function public.watch_party_topic_allowed with parameters p_bogus, p_topic …","hint":"Perhaps you meant to call the function public.watch_party_topic_allowed(p_topic)"}
```

So: one argument, `p_topic`, and the answer is a bare boolean with HTTP 200.
`p_topic: null`, `""` and `"watch-party:"` all answer `false` (no error).
The function is **not in the OpenAPI document**: `/rest/v1/` lists 68 paths and
the only one with "party" in it is `/rpc/watch_party_enabled`.

The join frame, exactly as Peli's `OpenChannel` sends it (token redacted):

```json
{"topic":"realtime:watch-party:<party-id>","event":"phx_join","payload":{"config":{"broadcast":{"ack":false,"self":false},"presence":{"key":"peli-spike-a","enabled":true},"postgres_changes":[],"private":true},"access_token":"<token>"},"ref":"1","join_ref":"1"}
```

**The party's own topic, A (host, holds the seat) then B (no seat at all):**

```
A <- event "phx_reply" ref 1 payload {"status":"ok","response":{"postgres_changes":[]}}
A <- event "presence_state" ref  payload {}
A <- event "phx_reply" ref 2 payload {"status":"ok","response":{}}     # presence track acked
A <- event "phx_reply" ref 3 payload {"status":"ok","response":{}}     # broadcast acked
A <- event "presence_diff" payload {"joins":{"peli-spike-a":{"metas":[{"phx_ref":"…","at":1795681024501,"code":"TEST","marker":"m-a15fbc","member_id":"<uuid>","status":"live"}]}},"leaves":{}}
B <- event "phx_reply" ref 1 payload {"status":"ok","response":{"postgres_changes":[]}}
B <- event "presence_state" payload {"peli-spike-a":{"metas":[{"phx_ref":"…","at":1795681024501,"code":"TEST","marker":"m-a15fbc","member_id":"<uuid>","status":"live"}]}}
B <- event "broadcast" payload {"event":"party_live","payload":{"code":"TEST","marker":"m-ff4679"},"type":"broadcast"}
A <- event "presence_diff" payload {"joins":{"peli-spike-b":{"metas":[{"phx_ref":"…","marker":"m-3a610f","member_id":"b-not-a-member","status":"loaded"}]}},"leaves":{}}
A <- event "presence_diff" payload {"joins":{},"leaves":{"peli-spike-b":{…}}}
```

Three things worth noting in that trace:

- A's **own broadcast is not echoed back** (`self: false`), but A's **own presence
  track comes back to A as a `presence_diff`** — a client has to ignore its own
  presence key. Peli's `presenceMetas` already surfaces it, so a design must key
  off its own member id.
- B joined and tracked **without ever calling `watch_party_join`** and without a
  seat; membership is not what the channel checks on the same account.
- Broadcast frames are acked (`phx_reply ok {}`) even with `ack: false` in the
  config, so a send that fails is visible.

**A frame A sent that B received** (this is the whole announcement mechanism, and
Peli already sends the same shape for its `reaction` event):

```json
{"topic":"realtime:watch-party:<party-id>","event":"broadcast","payload":{"type":"broadcast","event":"party_live","payload":{"code":"TEST","marker":"m-ff4679"}},"ref":"3","join_ref":"1"}
```

**Every account-ish topic, both sessions, both privacy modes:**

```
A private: phx_reply error {"reason":"Unauthorized: You do not have permissions to read from this Channel topic: account:<user-uuid>"}
B private: phx_reply error {"reason":"Unauthorized: You do not have permissions to read from this Channel topic: account:<user-uuid>"}
A public (private:false): phx_reply error {"reason":"PrivateOnly: This project only allows private channels"}
```

The same pair of answers came back for `watch-party:<random uuid>`,
`user:<user-uuid>`, `peli:<user-uuid>`, `profile:<user-uuid>:1`,
`account:<user-uuid>:parties`, `parties:<user-uuid>`, `watch-parties:<user-uuid>`
and `peli:parties:<user-uuid>`. `PrivateOnly` is the project-wide setting: there
is no public-channel escape hatch.

**Payload size, on the party topic, A → B:**

```
8192 bytes:  B got it (8295 bytes of payload)
102400 bytes: B got it: no   → B's socket ended right after with "failed to read frame header: EOF"
```

## What a design would use

- **Topic:** there is only one, `watch-party:<id>`, joined as
  `realtime:watch-party:<id>` with `private: true`, the session's `access_token`,
  `ref == join_ref`, and a presence key (Peli uses the party member id). No
  account-, profile- or Peli-namespaced topic is authorized, under any spelling
  tried, at either end (`topic_allowed` says `false`; the socket says
  `Unauthorized`). Nuvio would have to add the policy; Peli cannot.
- **Broadcast or presence:** both work on the party topic and both already go
  through Peli's `internal/nuvio` client. A broadcast (`{"event":"party_live",
  "payload":{"code":"TEST"}}`) is the announcement; a presence track is the
  roster, and it survives a late joiner. A design should use presence for "who is
  here" and one broadcast for "the party changed" — but all of it only inside a
  party that already exists.
- **Late join:** a channel that joins after A tracked receives A's whole
  presence map in its initial `presence_state`, metadata included (`phx_ref`,
  plus whatever was tracked). So a Join page that *knew* a party id could show
  the roster with no RPC at all. It cannot learn the id: there is no listing RPC,
  `watch_party_join` needs `p_code`, and `watch_party_topic_allowed` only answers
  yes for a party the account is already in.
- **Limits seen:** 8 KiB payloads arrive intact, 100 KiB neither arrives nor
  errors at the sender (the receiving socket ended with EOF), so stay well under
  8 KiB — Peli's own frames are hundreds of bytes. Joins answer synchronously
  with a reason, so a refusal is immediate and cheap. Peli heartbeats every 25 s
  against Phoenix's 60 s drop; nothing in this run came near either. One oddity
  worth knowing for long runs: across a run that opened ~30 sockets for one
  account, the long-lived party sockets ended by themselves (one normal closure,
  one EOF) — the spike had already read everything it needed, but don't assume a
  party socket survives heavy socket churn elsewhere in the same client.

## Untested and caveats

- **Cross-account isolation is untested.** No second real account was available
  and none was signed up. What the answers suggest: authorization is per-topic
  and looks membership-based — `watch-party:<random uuid>` is `false` and the
  join is `Unauthorized`, while a party the account owns is `true`. But a session
  of the owner's account with **no seat** also got in, so the check is at least
  account-wide, maybe wider. Whether another account's session could join
  `watch-party:<id>` with a leaked id is unanswered, and it decides whether the
  fallback below is safe to build on.
- **This is Nuvio's server policy, not a contract.** The party functions are not
  in the OpenAPI document (68 paths, one mention of `watch_party_enabled`), and
  `watch_party_topic_allowed` is undocumented beyond its parameter name. Nuvio
  can add an account topic (which would make this design possible) or tighten the
  party topic at any time, with no version signalling Peli could detect.
- **The weaker fallback is real but useless on its own:** B joined A's party
  topic, tracked, saw A's presence and received A's broadcasts without joining
  the party. Watch a *known* party, yes; discover one, no.
- **The 100 KiB result is one data point**, and the socket died around it, so
  "the limit is somewhere between 8 KiB and 100 KiB" is the honest reading.
- **Nothing was left behind.** Three parties were created across the session's
  runs (one per run) and every one was ended — `watch_party_end` answered
  `ok:true` each time, and the last run's cleanup line is `party ended: ok=true,
  error ""`. Six password-grant sessions were signed out with
  `context.Background()`. No profile was touched, no `watch_party_link_profile`,
  no new account, nothing written to `.agents/memory`.
- Timings in this run are the sandbox's, on a home connection — not a latency
  measurement.

## How to rerun

From the repo root — the spike lives in the root Go module, so it imports
`internal/nuvio` and needs no `go.mod` of its own:

```sh
cd /Users/kevinmallari/Developer/staysh
set -a; source spikes/nuvio-backend/.env; set +a
go run ./spikes/party-account-topic
```

It takes about 40 s and is polite on purpose: two sign-ins, one party (created
and ended), twenty `topic_allowed` calls (ten topics from both sessions) plus
five edge probes, ~30 short-lived sockets with a 300 ms gap between them, and
two payload-size probes. It prints everything redacted, so its
output can be pasted into this report. [`main.go`](main.go) is the whole probe;
`results/run.txt` is the run this report is written from.
