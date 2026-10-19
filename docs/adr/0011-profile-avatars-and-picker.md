---
status: accepted
date: 2026-10-20
---

# Profile avatars load from Nuvio's storage by URL, and the picker asks at launch when there's more than one profile

The profile picker (#24) shows each Nuvio profile's avatar. **Go resolves the avatar to an image URL at sign-in, and the webview loads that URL directly from Nuvio.** Nothing is downloaded into the local store. A profile without an image, or whose image can't load, shows its initials on its colour.

- **Where the image is.** `sync_pull_profiles` gives each profile an `avatar_id`, an `avatar_color_hex` and an `avatar_url` (null on the live account). `get_avatar_catalog` is public (the publishable key is enough) and maps each `avatar_id` to a `storage_path`. On live, that path is in the public `avatars` bucket: `https://api.nuvio.tv/storage/v1/object/public/avatars/<storage_path>`. We found the bucket name by trying it, since the catalog only gives the path. A profile's own `avatar_url` wins if it is http(s).
- **When.** Sign-in reads the catalog while it signs in, so it adds no wait. If the catalog fails, sign-in still succeeds and profiles get no image. `Profile.Avatar` (the URL) and `Profile.AvatarColor` (`#RRGGBB`, checked in Go and again before it's styled) are saved with the profile.
- **The picker.** **Who's watching?** opens at launch and after signing in when there's more than one profile on the device, the Guest included. The last profile used is focused, so Return picks it. The profile menu's **Switch profile** switches in place. Everything a profile owns is queried by its ID, so what's on screen follows without a restart.

## Why

- **Nuvio already hosts the images, with long cache lifetimes.** They're 220 KB PNGs served with `cache-control: max-age=31536000` and versioned paths (`otto-v1.png`). The webview's HTTP cache keeps them, so storing a copy ourselves would add code without saving a request.
- **The fallback carries the meaning, not the image.** Initials on the profile's own colour still tell profiles apart offline, before an image loads, and on a self-hosted backend whose bucket differs. Black or white initials, whichever has more contrast on that colour.
- **Asking every launch is what people expect** from streaming apps with profiles, and the kids story (#25, #26) needs whoever sits down to choose. Remembering the last profile keeps it to one key press.

## What we give up

- **The webview now loads remote content.** Until now it only talked to Go. The avatar URL comes from our own Nuvio client and must be http(s), and images can't run code, but a later Content-Security-Policy has to allow `img-src` for the backend.
- **Avatars and names are what Nuvio said at the last sign-in.** Nothing pulls profiles again until the sync module (#28) does it at launch.
- **A first launch offline shows initials,** even for profiles with avatars. We haven't checked how long WKWebView, WebView2 and WebKitGTK keep the cached images across restarts.
- **PIN-locked profiles open like the others for now.** #25 adds the PIN prompt to the picker and the menu.

## Revisit if

Avatars should show offline from the first launch, or a CSP needs every request to go through Go. Then have Go fetch each image once into the store's cache and serve it to the webview.
