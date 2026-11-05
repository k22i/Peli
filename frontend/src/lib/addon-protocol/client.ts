import { Service as Addons } from "@bindings/addons";

import {
  InvalidAnswer,
  parseCatalogResponse,
  parseManifest,
  parseMetaResponse,
  parseStreamResponse,
  parseSubtitlesResponse,
} from "./parse";
import type {
  CatalogResponse,
  ContentType,
  Extra,
  Manifest,
  MetaResponse,
  StreamResponse,
  SubtitlesResponse,
} from "./types";

// The one client for addon requests (#37). Each request has its own timeout
// and follows the caller's AbortSignal (TanStack Query's, in queries.ts). It
// fetches from the webview, and through Go (internal/addons) for an addon
// whose answers the webview can't read: no CORS headers, as on some error
// pages. An addon URL can embed the user's debrid key, so neither URLs nor
// answers are logged, and errors don't name them.

// Whether an addon runs inside Sinag (#107, ADR-0045):
// sinag://<name>/manifest.json, answered by Go and never synced to Nuvio.
export const isBuiltinAddon = (url: string) => /^sinag:\/\//i.test(url);

// Where an addon's manifest is. Lists synced from Nuvio hold some addons by
// their base URL ("https://opensubtitles-v3.strem.io"), Stremio by the
// manifest's, and links may use stremio://.
export function manifestUrl(url: string): string {
  const https = url.replace(/^stremio:\/\//, "https://");
  return https.endsWith("/manifest.json") ? https : `${https.replace(/\/+$/, "")}/manifest.json`;
}

// Where an addon's resources are: its manifest URL without /manifest.json.
// The path before it can be the user's config.
export function addonBase(url: string): string {
  return manifestUrl(url).slice(0, -"/manifest.json".length);
}

// The URL of one resource, such as
// {base}/catalog/movie/top/genre=Drama&skip=100.json. Ids keep their colons
// encoded (tt0903747%3A1%3A1), as Stremio sends them.
export function resourceUrl(
  addonUrl: string,
  resource: string,
  type: ContentType,
  id: string,
  extra?: Extra,
): string {
  const path = [resource, type, id].map(encodeURIComponent).join("/");
  const pairs = Object.entries(extra ?? {}).flatMap(([name, value]) => {
    if (value === undefined) return [];
    const values = typeof value === "object" ? value : [String(value)];
    return values.map((v) => `${encodeURIComponent(name)}=${encodeURIComponent(v)}`);
  });
  return `${addonBase(addonUrl)}/${path}${pairs.length > 0 ? `/${pairs.join("&")}` : ""}.json`;
}

// Why a request failed; `message` is for the user.
export type AddonErrorKind = "timeout" | "unreachable" | "status" | "invalid";

export class AddonError extends Error {
  readonly kind: AddonErrorKind;
  readonly status: number | undefined;

  constructor(kind: AddonErrorKind, message: string, status?: number) {
    super(message);
    this.name = "AddonError";
    this.kind = kind;
    this.status = status;
  }
}

const unreachable = () => new AddonError("unreachable", "The addon couldn’t be reached.");
const timedOut = () => new AddonError("timeout", "The addon didn’t answer.");

// How long each resource may take. Comet took up to 18 s for a popular
// title's streams (#6), and a slow addon's streams are still worth showing
// (#50), so streams get the longest.
export const timeouts = {
  manifest: 15_000,
  catalog: 20_000,
  meta: 15_000,
  stream: 30_000,
  subtitles: 15_000,
} as const;

export type RequestOptions = {
  signal?: AbortSignal | undefined;
  // Overrides the resource's timeout, in milliseconds.
  timeout?: number | undefined;
};

// How a request reaches an addon. Tests pass their own.
export type Transport = {
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  // Go's fetch; rejects with a cause of { code } from internal/addons.
  fetchViaGo: (url: string, signal: AbortSignal) => Promise<{ status: number; body: string }>;
};

const wailsTransport: Transport = {
  fetch: (url, init) => fetch(url, { ...init, headers: { Accept: "application/json" } }),
  fetchViaGo: (url, signal) => {
    const call = Addons.Fetch(url);
    const cancel = () => void call.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    return call.finally(() => signal.removeEventListener("abort", cancel));
  },
};

export function createAddonClient(transport: Transport = wailsTransport) {
  // Origins whose answers only Go could read. Kept for the session, so their
  // later requests skip the webview's failing attempt.
  const viaGo = new Set<string>();

  async function getText(url: string, timeout: number, signal?: AbortSignal) {
    const timer = AbortSignal.timeout(timeout);
    const both = signal ? AbortSignal.any([signal, timer]) : timer;
    // A built-in addon is only Go's to answer.
    const builtin = isBuiltinAddon(url);
    const origin = builtin ? "sinag:" : new URL(url).origin;
    const failed = (error: unknown) => {
      if (signal?.aborted) throw signal.reason;
      if (timer.aborted) throw timedOut();
      throw error;
    };

    if (!builtin && !viaGo.has(origin)) {
      let response: Response | undefined;
      try {
        response = await transport.fetch(url, { signal: both });
      } catch (error) {
        // A TypeError is any network failure, CORS included: let Go try.
        if (both.aborted || !(error instanceof TypeError)) failed(unreachable());
      }
      if (response) {
        const text = await response.text().catch(failed);
        return { status: response.status, text };
      }
    }

    try {
      const { status, body } = await transport.fetchViaGo(url, both);
      viaGo.add(origin);
      return { status, text: body };
    } catch (error) {
      if (both.aborted) failed(error);
      throw goCode(error) === "timeout" ? timedOut() : unreachable();
    }
  }

  async function get<T>(
    url: string,
    timeout: number,
    signal: AbortSignal | undefined,
    parse: (answer: unknown) => T,
    invalid = "The addon’s answer isn’t one Sinag can read.",
  ): Promise<T> {
    const { status, text } = await getText(url, timeout, signal);
    if (status < 200 || status >= 300) {
      throw new AddonError("status", `The addon answered ${status}.`, status);
    }
    try {
      return parse(JSON.parse(text));
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof InvalidAnswer) {
        throw new AddonError("invalid", invalid);
      }
      throw error;
    }
  }

  return {
    manifest: (url: string, options: RequestOptions = {}): Promise<Manifest> =>
      get(
        manifestUrl(url),
        options.timeout ?? timeouts.manifest,
        options.signal,
        parseManifest,
        "That isn’t an addon manifest.",
      ),

    catalog: (
      addonUrl: string,
      type: ContentType,
      id: string,
      extra?: Extra,
      options: RequestOptions = {},
    ): Promise<CatalogResponse> =>
      get(
        resourceUrl(addonUrl, "catalog", type, id, extra),
        options.timeout ?? timeouts.catalog,
        options.signal,
        parseCatalogResponse,
      ),

    meta: (
      addonUrl: string,
      type: ContentType,
      id: string,
      options: RequestOptions = {},
    ): Promise<MetaResponse> =>
      get(
        resourceUrl(addonUrl, "meta", type, id),
        options.timeout ?? timeouts.meta,
        options.signal,
        parseMetaResponse,
      ),

    streams: (
      addonUrl: string,
      type: ContentType,
      id: string,
      options: RequestOptions = {},
    ): Promise<StreamResponse> =>
      get(
        resourceUrl(addonUrl, "stream", type, id),
        options.timeout ?? timeouts.stream,
        options.signal,
        parseStreamResponse,
      ),

    // Extra is what the player knows of the file: videoHash, videoSize and
    // filename help an addon match subtitles to it.
    subtitles: (
      addonUrl: string,
      type: ContentType,
      id: string,
      extra?: Extra,
      options: RequestOptions = {},
    ): Promise<SubtitlesResponse> =>
      get(
        resourceUrl(addonUrl, "subtitles", type, id, extra),
        options.timeout ?? timeouts.subtitles,
        options.signal,
        parseSubtitlesResponse,
      ),
  };
}

export type AddonClient = ReturnType<typeof createAddonClient>;

export const addonClient = createAddonClient();

function goCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause: unknown = error.cause;
  return typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
    ? cause.code
    : undefined;
}
