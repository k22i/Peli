---
name: sinag-design-direction
description: "The user's chosen look for Sinag (Apple × Vercel × Nuvio), the lagoon brand colours and Mona Sans, and how they like design choices presented"
metadata:
  node_type: memory
  type: user
  originSessionId: df545a42-2938-4d36-87f3-16f93ac7098e
  modified: 2026-10-19T04:58:59.820Z
---

For Sinag's UI the user asked for "Apple, Vercel and Nuvio had a love child" and a less generic font than Inter. Settled in #13 (2026-10-19):
- **Font:** Mona Sans (variable, width axis; wide headings) + Geist Mono for metadata.
- **Accent:** a "lagoon" cyan-blue. Their first reaction to teal (#2EC4C6) was "lean towards a little more blue", so we went to `#33B5E0` dark / `#0B6E94` light (hue ~196°). It's the `--brand` token, because coss's `--accent` is the hover tint.
- They asked for exact hex codes before agreeing, so give concrete values with WCAG contrast numbers rather than describing colours in words.

**How to apply:** new UI should extend `docs/design/README.md` and the `/gallery` page rather than inventing new colours or fonts. Related: [[frontend-stack-preferences]].
