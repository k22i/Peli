---
status: accepted
date: 2026-10-19
---

# The Nuvio session: restored offline, refreshed at launch and halfway, and signing out removes the account's profiles

**Restore** reads the two tokens from the keychain (ADR-0007) and asks nothing of the network, so Sinag opens signed in when offline. **Refresh** happens in Go, in one place (`account.Session`, behind one lock). It runs once in the background at every launch, then halfway through each access token's life, and retries from 30 s up to every 15 min while offline. A **revoked** session (a refresh token that stops working) deletes the tokens but keeps every profile and its data, and sends the user to sign in again. **Sign out** ends the session on Nuvio, deletes the tokens, the account's linked profiles and their data, and the cache. Local profiles such as a guest's stay. #22 built this.

## Why

- **Refresh at launch is the only way to notice a revoked session.** Nuvio's access tokens last 7 days and are checked by signature alone, so a session that another device signed out keeps working until its refresh. Refreshing at launch is one request and isn't waited on. Halfway through the token's life covers apps left open for days. The refresher checks the wall clock every minute rather than setting one long timer, because Go timers don't count time asleep on macOS.
- **One refresher.** Refresh tokens rotate on use. On live, a second refresh with the token just rotated gets the same new session, even 8 minutes later (#22's probe), so a double refresh is less dangerous than gotcha 6 feared. A token two rotations old is refused (`refresh_token_already_used`, seen on self-host) while the newest keeps working, so what can sign Sinag out is a keychain left holding an old token. Still, every refresh, sign-in and sign-out goes through one mutex, and a call that finds its token refused refreshes only if no one else has already (`Session.Do`). The new refresh token is written to the keychain before the access token, so a half-written session can still be refreshed.
- **Ended is not signed out.** "Session ended" means linked profiles but no tokens. It survives relaunches without a flag of its own, and the profiles stay, so signing in again carries on with the same local data. Network errors and 5xx never end a session; only `ErrSignedOut` does (`refresh_token_not_found`, `refresh_token_already_used`, `session_not_found`, `session_expired`, or `invalid_grant` from an older GoTrue).
- **Sign out clears the account from the device**, as #22 asks ("clears per-account cache"). Nuvio has the account's data, and signing in again pulls it back. Queued changes are pushed first (#30, ADR-0017), while the session still works; the confirm dialog says that anything that can't be sent, such as offline, is lost.
- **Accounts don't merge.** The store records the linked account's user id (the JWT's `sub`). Signing in to a different account removes the previous account's profiles first, rather than merging them by Nuvio profile index.

## What we give up

- **A launch makes one refresh request** even when the token has days left. That rotates the refresh token once per launch, which is cheap and is how revocation is noticed.
- **Sign-out doesn't wait for the network.** If Nuvio can't be reached within 5 s, the local sign-out goes ahead and the backend session stays until it expires or is signed out from elsewhere.
- **Revocation is noticed late while Sinag stays open**: up to half a token's life (3.5 days on live), or at the next refused call once sync runs. Access tokens can't be checked more cheaply than with a refresh.
