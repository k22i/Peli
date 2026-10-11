// Shared plumbing for the probe: config, the supabase-js client, HTTP tracing and shape redaction.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(join(root, '.env'));
} catch {
  // No .env: everything comes from the real environment.
}

// Honest user agent: who we are and where to find us. supabase-js adds its own X-Client-Info.
export const userAgent = 'Staysh/0.0.0-spike (+https://github.com/k22i/Staysh; nuvio-backend spike)';

export type Target = { name: 'live' | 'local'; url: string; key: string; discovery: unknown };

// The key is never stored in the repo. NUVIO_KEY wins; otherwise it comes from the backend's
// public discovery document, which is what Nuvio documents for self-hosted clients.
export async function loadTarget(): Promise<Target> {
  const url = (process.env.NUVIO_URL ?? 'https://api.nuvio.tv').replace(/\/$/, '');
  const host = new URL(url).hostname;
  const name = host === 'localhost' || host === '127.0.0.1' ? 'local' : 'live';
  let discovery: unknown = null;
  let key = process.env.NUVIO_KEY ?? '';
  if (!key) {
    const res = await fetch(`${url}/.well-known/nuvio`, { headers: { 'User-Agent': userAgent } });
    if (!res.ok) throw new Error(`discovery failed: HTTP ${res.status}`);
    discovery = await res.json();
    key = (discovery as { publishable_key?: string }).publishable_key ?? '';
    if (!key) throw new Error('discovery document has no publishable_key; set NUVIO_KEY');
  }
  return { name, url, key, discovery };
}

// --- HTTP tracing -----------------------------------------------------------------------------

export type Trace = {
  at: string;
  label: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  headers: Record<string, string>;
};

const traces: Trace[] = [];
let traceLabel = '';
export function setTraceLabel(label: string) {
  traceLabel = label;
}
export function takeTraces(): Trace[] {
  return traces.splice(0, traces.length);
}

const interestingHeaders = /^(x-ratelimit|ratelimit|retry-after|x-kong|via|server|cf-ray|cf-cache-status|content-range|sb-|x-sb)/i;

export const tracingFetch: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  const started = performance.now();
  const res = await fetch(req);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    // sb-auth-user-id carries the account's UUID.
    if (interestingHeaders.test(k)) headers[k] = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v) ? '<uuid>' : v;
  });
  const u = new URL(req.url);
  const t: Trace = {
    at: new Date().toISOString(),
    label: traceLabel,
    method: req.method,
    path: u.pathname,
    status: res.status,
    ms: Math.round(performance.now() - started),
    headers,
  };
  traces.push(t);
  if (process.env.PROBE_VERBOSE) console.error(`  ${t.method} ${t.path} -> ${t.status} ${t.ms}ms`);
  return res;
};

// --- Client -----------------------------------------------------------------------------------

// Sessions persist in .session/<target>.json (git-ignored), so commands don't sign in again.
function fileStorage(file: string) {
  const read = (): Record<string, string> => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
  return {
    getItem: (k: string) => read()[k] ?? null,
    setItem: (k: string, v: string) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ ...read(), [k]: v }), { mode: 0o600 });
    },
    removeItem: (k: string) => {
      const all = read();
      delete all[k];
      writeFileSync(file, JSON.stringify(all), { mode: 0o600 });
    },
  };
}

export function makeClient(t: Target, sessionName = t.name): SupabaseClient {
  return createClient(t.url, t.key, {
    auth: {
      storage: fileStorage(join(root, '.session', `${sessionName}.json`)),
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { headers: { 'User-Agent': userAgent }, fetch: tracingFetch },
  });
}

// --- Output -----------------------------------------------------------------------------------

// Replace values with their JSON types so committed results describe the contract, not the account.
// Enum-like fields keep their value because they are part of the contract.
const keepValues = new Set(['operation', 'content_type', 'poster_shape', 'status', 'platform', 'provider', 'tracker']);
export function shapeOf(v: unknown, key = ''): unknown {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length === 0 ? [] : [shapeOf(v[0], key), `…${v.length} item(s)`];
  if (typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, shapeOf(x, k)]));
  }
  if (keepValues.has(key) && typeof v === 'string') return `string = ${JSON.stringify(v)}`;
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) return 'string (timestamptz)';
  if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v)) return 'string (uuid)';
  return typeof v;
}

// One-time TV login secrets are redacted too, even though they are spent after the run.
const secretArgs = new Set(['p_code', 'p_device_nonce']);
export function writeResult(name: string, data: unknown) {
  const file = join(root, 'results', name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, (k, v) => (secretArgs.has(k) && typeof v === 'string' ? '<redacted>' : v), 2) + '\n');
  console.error(`wrote ${file.slice(root.length + 1)}`);
}

export function appendRaw(name: string, data: unknown) {
  const file = join(root, 'results', 'raw', name);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(data) + '\n');
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
