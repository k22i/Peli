// Probe of Nuvio's backend contract for #5. Throwaway; see ../README.md.
//
//   node src/probe.ts <command> [args]
//
// Targets https://api.nuvio.tv unless NUVIO_URL is set (e.g. http://localhost:8000 for a local
// self-host stack). Credentials come from .env / the environment and are never written to results/.
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomBytes, randomUUID } from 'node:crypto';
import qrcode from 'qrcode-terminal';
import {
  appendRaw,
  loadTarget,
  makeClient,
  setTraceLabel,
  shapeOf,
  sleep,
  takeTraces,
  type Target,
  type Trace,
  userAgent,
  writeResult,
} from './lib.ts';

const profile = Number(process.env.NUVIO_PROFILE ?? 1);
// Identifies this client's writes. Nuvio's push functions accept it (p_origin_client_id).
const originClientId = 'cove-spike';

type Call = { fn: string; args: Record<string, unknown>; status: 'ok' | 'error'; ms: number; rows?: number; shape?: unknown; error?: unknown };

async function rpc(sb: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<Call & { data?: unknown }> {
  setTraceLabel(fn);
  const started = performance.now();
  const { data, error } = await sb.rpc(fn, args);
  const ms = Math.round(performance.now() - started);
  if (error) return { fn, args, status: 'error', ms, error: { code: error.code, message: error.message, details: error.details, hint: error.hint } };
  return { fn, args, status: 'ok', ms, rows: Array.isArray(data) ? data.length : undefined, shape: shapeOf(data), data };
}

async function signedIn(t: Target, session = t.name): Promise<SupabaseClient> {
  const sb = makeClient(t, session);
  const { data } = await sb.auth.getSession();
  if (!data.session) throw new Error(`no saved session for ${session}; run "signin" or "tv-login" first`);
  return sb;
}

const strip = ({ data: _data, ...call }: Call & { data?: unknown }) => call;

// --- Commands ---------------------------------------------------------------------------------

const commands: Record<string, (t: Target, args: string[]) => Promise<void>> = {
  async discover(t) {
    writeResult(`${t.name}-discovery.json`, { ...(t.discovery as object), publishable_key: '<redacted: public client key>' });
  },

  // Email/password sign-in (#20). NUVIO_EMAIL / NUVIO_PASSWORD.
  async signin(t) {
    const sb = makeClient(t);
    setTraceLabel('signInWithPassword');
    const started = performance.now();
    const { data, error } = await sb.auth.signInWithPassword({ email: need('NUVIO_EMAIL'), password: need('NUVIO_PASSWORD') });
    const ms = Math.round(performance.now() - started);
    if (error) throw new Error(`sign-in failed (${error.status} ${error.code}): ${error.message}`);
    const s = data.session!;
    console.log(`signed in in ${ms} ms; access token expires in ${s.expires_in} s`);
    writeResult(`${t.name}-signin.json`, { ms, session: shapeOf(s), user: shapeOf(data.user), traces: takeTraces() });
  },

  // Local only: create a throwaway account so the contract can be exercised without a real one.
  async signup(t, [email = `spike-${Date.now()}@example.com`]) {
    if (t.name !== 'local') throw new Error('signup is only for a local self-host backend');
    const sb = makeClient(t, process.env.PROBE_SESSION ?? t.name);
    const { error } = await sb.auth.signUp({ email, password: need('NUVIO_PASSWORD') });
    if (error) throw error;
    console.log(`created ${email}`);
  },

  // QR / device-code sign-in (#21): start a TV login session as anon, show the QR, poll, exchange.
  async 'tv-login'(t, [redirect = process.env.NUVIO_TV_LOGIN_URL ?? 'https://nuvio.tv/tv-login']) {
    const sb = makeClient(t);
    const nonce = randomBytes(24).toString('hex');
    const started = await rpc(sb, 'start_tv_login_session', { p_device_nonce: nonce, p_redirect_base_url: redirect, p_device_name: 'Cove (spike)' });
    if (started.status === 'error') throw new Error(JSON.stringify(started.error));
    const s = (started.data as { code: string; web_url: string; expires_at: string; poll_interval_seconds: number }[])[0];
    console.log(`\nScan with the Nuvio app, or open ${s.web_url}\ncode ${s.code}, expires ${s.expires_at}\n`);
    qrcode.generate(s.web_url, { small: true });
    const log: unknown[] = [strip(started)];
    const t0 = Date.now();
    let status = 'pending';
    while (status === 'pending') {
      await sleep(s.poll_interval_seconds * 1000);
      const p = await rpc(sb, 'poll_tv_login_session', { p_code: s.code, p_device_nonce: nonce });
      log.push({ ...strip(p), atSec: Math.round((Date.now() - t0) / 1000) });
      if (p.status === 'error') throw new Error(JSON.stringify(p.error));
      status = (p.data as { status: string }[])[0].status;
      process.stderr.write(`  ${status}\n`);
    }
    if (status !== 'approved') throw new Error(`TV login ended as ${status}`);
    setTraceLabel('tv-logins-exchange');
    const ex = await sb.functions.invoke('tv-logins-exchange', { body: { code: s.code, device_nonce: nonce } });
    if (ex.error) throw new Error(`exchange failed: ${ex.error.message}`);
    log.push({ fn: 'functions/v1/tv-logins-exchange', shape: shapeOf(ex.data) });
    const tok = ex.data as { access_token: string; refresh_token: string };
    const { error } = await sb.auth.setSession(tok);
    if (error) throw error;
    console.log(`signed in via QR after ${Math.round((Date.now() - t0) / 1000)} s`);
    writeResult(`${t.name}-tv-login.json`, { redirect, approvedAfterSec: Math.round((Date.now() - t0) / 1000), steps: log, traces: takeTraces() });
  },

  // Stand-in for the phone app on a local backend: approve a code as the signed-in account.
  async approve(t, [code]) {
    const sb = await signedIn(t, process.env.PROBE_SESSION ?? t.name);
    console.log(JSON.stringify(strip(await rpc(sb, 'approve_tv_login_session', { p_code: code }))));
  },

  // Every client-facing read function, with shapes and timings (redacted values).
  async catalog(t) {
    const sb = await signedIn(t);
    const p = { p_profile_id: profile };
    const calls = [
      await rpc(sb, 'get_sync_owner'),
      await rpc(sb, 'get_sync_overview'),
      await rpc(sb, 'sync_pull_profiles'),
      await rpc(sb, 'sync_pull_profile_locks'),
      await rpc(sb, 'sync_pull_library', { ...p, p_limit: 500, p_offset: 0 }),
      await rpc(sb, 'sync_get_library_delta_cursor', p),
      await rpc(sb, 'sync_pull_library_delta', { ...p, p_since_event_id: 0, p_limit: 5 }),
      await rpc(sb, 'sync_pull_watch_progress', { ...p }),
      await rpc(sb, 'sync_get_watch_progress_delta_cursor', p),
      await rpc(sb, 'sync_pull_watch_progress_delta', { ...p, p_since_event_id: 0, p_limit: 5 }),
      await rpc(sb, 'sync_pull_watched_items', { ...p, p_page: 1, p_page_size: 500 }),
      await rpc(sb, 'sync_get_watched_items_delta_cursor', p),
      await rpc(sb, 'sync_pull_watched_items_delta', { ...p, p_since_event_id: 0, p_limit: 5 }),
      await rpc(sb, 'sync_pull_collections', p),
      await rpc(sb, 'sync_pull_home_catalog_settings', { ...p, p_platform: 'desktop' }),
      await rpc(sb, 'sync_pull_profile_settings_blob', { ...p, p_platform: 'desktop' }),
      await rpc(sb, 'get_avatar_catalog'),
      await rpc(sb, 'list_my_sessions'),
    ];
    // Addons and plugins have no pull function: clients read the tables through PostgREST + RLS.
    for (const table of ['addons', 'plugins']) {
      setTraceLabel(`GET ${table}`);
      const started = performance.now();
      const { data, error } = await sb.from(table).select('*').eq('profile_id', profile).order('sort_order');
      const ms = Math.round(performance.now() - started);
      calls.push(error
        ? { fn: `GET /rest/v1/${table}`, args: { profile_id: profile }, status: 'error', ms, error }
        : { fn: `GET /rest/v1/${table}`, args: { profile_id: profile }, status: 'ok', ms, rows: data.length, shape: shapeOf(data), data });
    }
    for (const c of calls) appendRaw(`${t.name}-catalog.jsonl`, c);
    writeResult(`${t.name}-catalog.json`, { profile, calls: calls.map(strip), traces: summarize(takeTraces()) });
    for (const c of calls) console.log(`${c.status === 'ok' ? 'ok ' : 'ERR'} ${c.fn.padEnd(40)} ${String(c.ms).padStart(5)} ms ${c.rows ?? ''} ${c.status === 'error' ? JSON.stringify(c.error) : ''}`);
  },

  // Full pull of every surface, paging delta feeds from cursor 0 to the end (what a first launch does).
  async pull(t) {
    const sb = await signedIn(t);
    const out: Record<string, unknown> = {};
    for (const surface of ['library', 'watch_progress', 'watched_items']) {
      const cursor = await rpc(sb, `sync_get_${surface}_delta_cursor`, { p_profile_id: profile });
      let since = 0;
      let pages = 0;
      let events = 0;
      const ops: Record<string, number> = {};
      const started = performance.now();
      for (;;) {
        const page = await rpc(sb, `sync_pull_${surface}_delta`, { p_profile_id: profile, p_since_event_id: since, p_limit: 1000 });
        if (page.status === 'error') throw new Error(JSON.stringify(page.error));
        const rows = page.data as { event_id: number; operation: string }[];
        pages++;
        events += rows.length;
        for (const r of rows) ops[r.operation] = (ops[r.operation] ?? 0) + 1;
        if (rows.length === 0) break;
        since = rows[rows.length - 1].event_id;
        if (rows.length < 1000) break;
      }
      out[surface] = { cursor: cursor.data, lastEventSeen: since, pages, events, ops, ms: Math.round(performance.now() - started), cursorMatchesFeed: cursor.data === since };
    }
    writeResult(`${t.name}-pull.json`, { profile, surfaces: out, traces: summarize(takeTraces()) });
    console.log(JSON.stringify(out, null, 2));
  },

  // Push one progress entry and time how long until a second session sees it in its delta feed.
  // Args: content id (e.g. an IMDb id), type (movie|series), [season episode]. Position = 10 min.
  async 'push-progress'(t, [contentId, type = 'movie', season, episode]) {
    if (!contentId) throw new Error('usage: push-progress <content_id> [movie|series] [season episode]');
    const writer = await signedIn(t);
    const reader = makeClient(t, `${t.name}-reader`);
    const ws = (await writer.auth.getSession()).data.session!;
    await reader.auth.setSession({ access_token: ws.access_token, refresh_token: ws.refresh_token });
    const before = await rpc(reader, 'sync_get_watch_progress_delta_cursor', { p_profile_id: profile });
    const now = Date.now();
    const entry: Record<string, unknown> = {
      content_id: contentId,
      content_type: type,
      video_id: season ? `${contentId}:${season}:${episode}` : contentId,
      position: 10 * 60_000,
      duration: 100 * 60_000,
      last_watched: now,
      ...(season ? { season: Number(season), episode: Number(episode) } : {}),
    };
    const push = await rpc(writer, 'sync_push_watch_progress', { p_entries: [entry], p_profile_id: profile, p_origin_client_id: originClientId });
    if (push.status === 'error') throw new Error(JSON.stringify(push.error));
    const pushedAt = performance.now();
    let seenMs = -1;
    let event: unknown = null;
    for (let i = 0; i < 60; i++) {
      const d = await rpc(reader, 'sync_pull_watch_progress_delta', { p_profile_id: profile, p_since_event_id: before.data, p_limit: 1000 });
      const rows = (d.data ?? []) as { content_id: string; last_watched: number }[];
      const hit = rows.find((r) => r.content_id === contentId && r.last_watched === now);
      if (hit) {
        seenMs = Math.round(performance.now() - pushedAt);
        event = shapeOf(hit);
        break;
      }
      await sleep(500);
    }
    console.log(`push ${push.ms} ms; visible to a second session after ${seenMs} ms (cursor was ${before.data})`);
    console.log(`now check the Nuvio app: "${contentId}" should show ~10 min of progress (pushed at ${new Date(now).toISOString()})`);
    writeResult(`${t.name}-push-progress.json`, { profile, pushMs: push.ms, secondSessionSeenAfterMs: seenMs, entryShape: shapeOf(entry), event, traces: summarize(takeTraces()) });
  },

  // Undo push-progress: delete the content's progress rows and show the delete in the delta feed.
  async 'delete-progress'(t, [contentId]) {
    if (!contentId) throw new Error('usage: delete-progress <content_id>');
    const sb = await signedIn(t);
    const before = await rpc(sb, 'sync_get_watch_progress_delta_cursor', { p_profile_id: profile });
    const all = await rpc(sb, 'sync_pull_watch_progress', { p_profile_id: profile });
    const keys = ((all.data ?? []) as { content_id: string; progress_key: string }[]).filter((r) => r.content_id === contentId).map((r) => r.progress_key);
    if (keys.length === 0) throw new Error(`no progress for ${contentId}`);
    const del = await rpc(sb, 'sync_delete_watch_progress', { p_keys: keys, p_profile_id: profile, p_origin_client_id: originClientId });
    if (del.status === 'error') throw new Error(JSON.stringify(del.error));
    const feed = await rpc(sb, 'sync_pull_watch_progress_delta', { p_profile_id: profile, p_since_event_id: before.data, p_limit: 1000 });
    const left = await rpc(sb, 'sync_pull_watch_progress', { p_profile_id: profile });
    console.log(`deleted ${keys.length} row(s) in ${del.ms} ms; ${left.rows} progress row(s) left`);
    writeResult(`${t.name}-delete-progress.json`, { profile, deleted: keys.length, deleteMs: del.ms, deleteEvent: shapeOf(feed.data), rowsLeft: left.rows });
  },

  // Repeat a push that differs by less than the server's thresholds and check it is dropped.
  async 'push-throttle'(t, [contentId]) {
    if (!contentId) throw new Error('usage: push-throttle <content_id>');
    // It ends at 92 %, which creates a watched item: keep it off real accounts.
    if (t.name !== 'local') throw new Error('push-throttle only runs against a local backend');
    const sb = await signedIn(t);
    const base = { content_id: contentId, content_type: 'movie', video_id: contentId, duration: 100 * 60_000 };
    const steps: unknown[] = [];
    const t0 = Date.now();
    for (const [label, pos, dt] of [
      ['first', 20 * 60_000, 0],
      ['+5 s position, +5 s clock', 20 * 60_000 + 5_000, 5_000],
      ['+20 s position, +6 s clock', 20 * 60_000 + 20_000, 6_000],
      ['+0 s position, +40 s clock', 20 * 60_000 + 20_000, 46_000],
      ['to 92 % (crosses the watched line)', 92 * 60_000, 47_000],
    ] as const) {
      const cursor = (await rpc(sb, 'sync_get_watch_progress_delta_cursor', { p_profile_id: profile })).data as number;
      const push = await rpc(sb, 'sync_push_watch_progress', { p_entries: [{ ...base, position: pos, last_watched: t0 + dt }], p_profile_id: profile, p_origin_client_id: originClientId });
      const after = (await rpc(sb, 'sync_get_watch_progress_delta_cursor', { p_profile_id: profile })).data as number;
      const watched = await rpc(sb, 'sync_pull_watched_items_delta', { p_profile_id: profile, p_since_event_id: 0, p_limit: 1000 });
      const isWatched = ((watched.data ?? []) as { content_id: string }[]).some((w) => w.content_id === contentId);
      steps.push({ label, status: push.status, newProgressEvent: after > cursor, watchedItemExists: isWatched });
    }
    console.table(steps);
    writeResult(`${t.name}-push-throttle.json`, { profile, steps });
  },

  // Error cases a client has to handle.
  async errors(t) {
    const anon = makeClient(t, `${t.name}-anon`);
    await anon.auth.signOut({ scope: 'local' });
    const cases: unknown[] = [];
    const add = async (label: string, sb: SupabaseClient, fn: string, args: Record<string, unknown> = {}) => cases.push({ label, ...strip(await rpc(sb, fn, args)) });
    await add('no session (anon key only)', anon, 'sync_pull_profiles');
    await add('unknown function', anon, 'sync_pull_everything');
    await add('authenticated-only function as anon', anon, 'sync_pull_library', { p_profile_id: 1 });
    setTraceLabel('signInWithPassword wrong');
    const bad = await anon.auth.signInWithPassword({ email: process.env.NUVIO_EMAIL ?? 'nobody@example.com', password: 'definitely-wrong-password' });
    cases.push({ label: 'wrong password', status: bad.error?.status, code: bad.error?.code, message: bad.error?.message });
    const forged = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImV4cCI6MTAwMDAwMDAwMH0.c2lnbmF0dXJl';
    setTraceLabel('expired/forged JWT');
    const res = await fetch(`${t.url}/rest/v1/rpc/sync_pull_profiles`, { method: 'POST', headers: { apikey: t.key, Authorization: `Bearer ${forged}`, 'Content-Type': 'application/json', 'User-Agent': userAgent }, body: '{}' });
    cases.push({ label: 'expired / bad-signature JWT', httpStatus: res.status, body: await res.json().catch(() => null) });
    try {
      const sb = await signedIn(t);
      await add('profile id out of range (7)', sb, 'sync_push_library_items', { p_items: [], p_profile_id: 7, p_origin_client_id: originClientId });
      await add('wrong argument name', sb, 'sync_pull_library', { profile_id: 1 });
      await add('wrong argument type', sb, 'sync_pull_library_delta', { p_profile_id: 'one', p_since_event_id: 0, p_limit: 10 });
      await add('poll unknown TV code', sb, 'poll_tv_login_session', { p_code: 'nope', p_device_nonce: 'nope-nope-nope' });
      await add('approve unknown TV code', sb, 'approve_tv_login_session', { p_code: 'nope' });
    } catch (e) {
      cases.push({ label: 'signed-in cases skipped', reason: String(e) });
    }
    writeResult(`${t.name}-errors.json`, { cases, traces: summarize(takeTraces()) });
    console.log(JSON.stringify(cases, null, 2));
  },

  // Rate limits. On the live backend this only reports what normal traffic shows; it never floods.
  // On a local backend it hammers sign-in and an RPC until a 429 (or the cap) to see the behaviour.
  async ratelimit(t, [n = '60']) {
    const cap = Number(n);
    const anon = makeClient(t, `${t.name}-anon`);
    const results: Record<string, unknown> = {};
    if (t.name !== 'local') throw new Error('ratelimit only floods a local backend; read live headers from the other results');
    for (const [label, call] of [
      ['wrong-password sign-in', () => anon.auth.signInWithPassword({ email: 'nobody@example.com', password: 'wrong-password' }).then((r) => r.error?.status ?? 200)],
      ['health_ping RPC', () => anon.rpc('health_ping').then((r) => r.status)],
      ['start_tv_login_session RPC', () => anon.rpc('start_tv_login_session', { p_device_nonce: randomUUID(), p_redirect_base_url: 'https://example.com/tv-login' }).then((r) => (r.error ? `${r.status} ${r.error.message}` : r.status))],
    ] as const) {
      const statuses: Record<string, number> = {};
      let first429 = -1;
      for (let i = 0; i < cap; i++) {
        const s = String(await call());
        statuses[s] = (statuses[s] ?? 0) + 1;
        if (s.startsWith('429') && first429 < 0) first429 = i + 1;
      }
      results[label] = { requests: cap, statuses, first429 };
    }
    writeResult(`${t.name}-ratelimit.json`, { results, headersSeen: summarize(takeTraces()).headers });
    console.log(JSON.stringify(results, null, 2));
  },
};

function summarize(traces: Trace[]) {
  const headers: Record<string, string[]> = {};
  for (const tr of traces) {
    for (const [k, v] of Object.entries(tr.headers)) {
      if (/^(cf-ray|x-kong-request-id|date)$/i.test(k)) continue;
      (headers[k] ??= []).includes(v) || headers[k].push(v);
    }
  }
  return { requests: traces.map(({ label, method, path, status, ms }) => ({ label, method, path, status, ms })), headers };
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (put it in spikes/nuvio-backend/.env)`);
  return v;
}

const [cmd = 'help', ...args] = process.argv.slice(2);
if (!commands[cmd]) {
  console.log(`commands: ${Object.keys(commands).join(', ')}`);
  process.exit(cmd === 'help' ? 0 : 1);
}
const target = await loadTarget();
console.error(`target: ${target.name} (${target.url})`);
await commands[cmd](target, args);
