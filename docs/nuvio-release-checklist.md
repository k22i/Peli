# Nuvio release checklist

Nuvio's sync functions are undocumented (ADR-0020). CI tests Sinag against a pinned self-hosted backend every day, but that can't see changes on api.nuvio.tv. Go through this list when one of these ships:

- a Nuvio mobile or TV release (iOS, Android, Android TV), or a change on nuvio.tv;
- a new commit in [`NuvioMedia/self-host`](https://github.com/NuvioMedia/self-host) that touches `database/` or `volumes/functions/`.

Allow 15 minutes. If anything fails, open an issue labelled `area:sync` with the output (redacted: no email, user ID or tokens) and link it from #27.

## 1. Read what changed

- [ ] Read the release notes, and self-host's commits since the pinned ref (`NUVIO_SELF_HOST_REF` in `.github/workflows/ci.yml`): `git log --oneline <ref>..origin/main -- database volumes/functions`.
- [ ] Look for anything about sync, profiles, PINs, addons, device login (QR / TV login) or watch progress. Note any function that was renamed, gained or lost an argument, or changed what it returns.

## 2. Run the contract against the new self-host

- [ ] Clone self-host at the new commit into a scratch folder. Run `./nuvio setup --no-import-account`, set `COMPOSE_PROJECT_NAME` to something unused in `.env` (and `POSTGRES_PORT` if 5432 is taken), then run `./nuvio up`.
- [ ] `SINAG_CONTRACT_URL=http://localhost:8000 go test -v -count=1 -run 'TestContract|TestProgressReachesAnotherDevice' ./internal/nuvio ./internal/syncer`
- [ ] Read the `also sends …` lines: a new field may be worth reading.
- [ ] If it passes, bump `NUVIO_SELF_HOST_REF` in `ci.yml` and run the CI workflow by hand with **contract** ticked. If it fails, fix the client (and `nuviotest`, so the fake agrees) before bumping.
- [ ] `./nuvio down` when done.

## 3. Check live

Use a real account: the user's is in `spikes/nuvio-backend/.env` (git-ignored). `TestLiveSync` writes one progress entry and deletes it again.

- [ ] `set -a; source spikes/nuvio-backend/.env; set +a`
- [ ] `SINAG_NUVIO_LIVE=1 SINAG_NUVIO_LIVE_WRITES=1 go test -v -count=1 -run 'TestLive$|TestLiveSync|TestLiveDeviceLogin' ./internal/nuvio`
- [ ] Compare its `also sends …` lines with the self-host run. A field that's only on one side is drift; note it in ADR-0020.

## 4. Check by hand, with the new Nuvio app

- [ ] Sign in to Sinag with QR from the phone.
- [ ] Play something in Sinag for a minute, then pause. Within 30 s it shows in Continue Watching on the phone at the same spot.
- [ ] Mark an episode watched on the phone. It shows as watched in Sinag after focusing the window.
- [ ] Install an addon on the phone. It shows in Sinag's addon list after the next pull. Remove it again.
- [ ] Rename a profile in Sinag. The phone shows the new name. Rename it back.

## 5. Record it

- [ ] Comment on #27 with the app version checked, the self-host ref, and the results.
