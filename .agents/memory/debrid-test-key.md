---
name: debrid-test-key
description: The user has a TorBox API key for testing debrid addon responses; where it lives and how it must be handled
metadata:
  node_type: memory
  type: reference
  originSessionId: 2719b65f-17a2-494b-a391-607c7e4b4617
  modified: 2026-10-11T13:05:35.310Z
---

The user has a **TorBox** API key (no Real-Debrid / AllDebrid / Premiumize). They put it in `spikes/stream-ranking/.env` as `TORBOX_API_KEY` (git-ignored) for #6, at my request. They chose to provide it rather than skip debrid coverage.

How to apply: for later debrid work (#49 Streams epic, #51 ranking engine), reuse that `.env` instead of asking again. Never print the value, and redact keys and opaque tokens from anything recorded (`spikes/stream-ranking/src/redact.ts`; Torrentio resolve URLs embed the key in the path). Related: [[spike-ticket-workflow]].
