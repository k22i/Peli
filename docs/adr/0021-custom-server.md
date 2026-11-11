---
status: accepted
date: 2026-10-27
---

# A custom server: one client pointed at it, the URL in the store, the key in the keychain, and switching signs out

Peli can sync with the user's own Nuvio-compatible backend, such as [NuvioMedia/self-host](https://github.com/NuvioMedia/self-host), in place of Nuvio's (#34, F6). It is also the way out if Peli loses access to the hosted backend (ADR-0004). A custom server speaks Nuvio's protocol (the same Supabase Auth, PostgREST RPCs and tables), so nothing in the sync module changes. This ADR covers how the app switches to one and what it keeps.

## One client, pointed somewhere else

`nuvio.Client.UseServer(url, key)` changes the backend the one client calls. `account`, `backend.Nuvio` and the syncer all hold that client, so a switch reaches every call without rebuilding services. Each request reads the URL and key together, so a request never takes one server's key to another. `Client.ServerURL` says which is in use. The URL the client starts with (Nuvio's, or `$PELI_NUVIO_URL` for development) is "Nuvio's server".

## The key is optional

The ticket asked for a URL and an anon key. Self-host publishes its key at `/.well-known/nuvio`, just like api.nuvio.tv, so the key field is optional. Left empty, the key is read from the discovery document. Given, it is used in place of that, which covers a Supabase project with Nuvio's schema and no discovery document. It is a publishable key, not a secret, but it is kept in the keychain (`nuvio.server-key`, ADR-0007) as the ticket asks, and it never goes back to the webview. The URL is kept in the local store (`settings/server`), outside `DeviceSettings`, so the frontend can't overwrite it by saving device settings.

## The check

`Client.CheckServer` (bound as `Account.TestServer`) reads the public avatar catalog from the server through a throwaway client. That one call needs no session and writes nothing. It also shows the key works and Nuvio's functions are there. Errors: `not_nuvio_server` (no discovery document, a 404 for the RPC, or a web page where JSON was expected), `server_key_refused` (a 401: no session was sent, so it can only be the key), and the usual `unreachable`/`unavailable`. `SetServer` runs the same check before changing anything, so a failed check leaves the session and server as they were. Going back to Nuvio's server isn't checked, so it works offline.

Addresses must be `https://` or `http://` with a host, no credentials, query or fragment. `http` is allowed for a server on the user's own network.

## Switching signs out

A session, its profile indexes and its sync cursors belong to one server. `Account.SetServer` to another server first does what `SignOut` does (ADR-0009): it flushes the outbox to the old server, ends the session there, removes the account's profiles and the cache, and deletes the tokens. A kids profile in use asks for the parent PIN first (ADR-0014). The Guest stays (ADR-0010). Then it saves the key, then the URL, and points the client at the new server. The URL is saved last, so a crash in between restores the old server at launch. The frontend clears its in-memory cache and goes to Home, or to the welcome screen when no profiles are left.

A new key for the **same** server keeps the session: the accounts are the same.

At launch, `account.Service.ServiceStartup` restores the saved server before the session's first refresh. If the keychain can't give the key (locked, say), the discovery document's is used.

## QR sign-in needs Nuvio's server

The QR code opens nuvio.tv/link, which approves sign-ins to Nuvio's backend only (ADR-0013). On a custom server, `StartQRSignIn` refuses with `qr_unavailable`, and the welcome and sign-in screens offer only email and password, named for the server ("Sign in to your server").

## What we give up

- **No migration between servers.** Switching removes the account's data from this device. The new server's account starts with whatever it has. Moving a library from Nuvio to self-host is self-host's import (`./nuvio import-account`), not Peli's.
- **One server at a time.** A device can't have profiles from two servers.
- **The check proves the protocol, not the version.** A server on an older or newer self-host may still differ in a call the check doesn't make. The contract tests (ADR-0020) pin the self-host version Peli is tested against.

## Revisit if

Users want to keep a Nuvio account and a self-hosted one on the same device, or self-host ships its own device-link page (then QR sign-in could follow the server's discovery document). Home layout and collections (#35) may sync to a custom server but never to Nuvio's; `Account.Server().Custom` tells them apart.
