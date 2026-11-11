---
name: product-name-peli
description: The app is Peli (renamed from Sinag on 2026-11-11, from Cove before that), with a pelican mark; what moved with the rename and what still says Sinag or Cove
metadata:
  type: project
---

The product is **Peli**, renamed from Sinag on 2026-11-11 at the user's request (Sinag, Tagalog for a ray of light, replaced Cove on 2026-10-19). "Peli" plays on pelican, and it is Spanish slang for a film. The logo is a pelican; see [[peli-design-direction]].

**Why:** the user chose the name. Earlier names were dropped because apps with them existed: "Cove" (a media player) and "Marquee" (a Plex-related app). A quick web search on 2026-11-11 found no streaming app named Peli. Peli Products (protective cases, Pelican's European brand) is a different trade class. Formal trademark, domain and store checks are still open in #82.

**How to apply:** the repo is `k22i/Peli` (GitHub redirects `k22i/Sinag`), the module is `github.com/k22i/Peli`, the bundle id is `k22i.net.peli`, the keychain service is `Peli`, data lives in `Peli/peli.db`, env vars start `PELI_`, and built-in addons use `peli://`. The app moves an existing Sinag install on first run: the data and cache folders, keychain items (read lazily from the `Sinag` service), and `sinag://` addon URLs. The `--sun` colour token kept its name. Recorded results under `spikes/*/results` deliberately still say Cove.
