import type { Stream } from "@/lib/addon-protocol";

import type { TitleContext } from "./context";
import type { RankedView } from "./engine";
import { serve, type Ranked, type Request, type Update } from "./protocol";
import type { Candidate, Prefs } from "./score";

// The page's side of the ranking worker (#51). One worker serves every
// picker, started when a title page opens so its first, slow run is over by
// the time streams arrive. Where there are no workers (tests), or the worker
// fails to start, the same engine runs on the page.

type Port = { post: (request: Request) => void };

let port: Port | undefined;
const sessions = new Map<number, RankingSession>();
let nextSession = 1;

function local(): Port {
  const handle = serve((update) => sessions.get(update.session)?.receive(update));
  // Answer later, as a worker would.
  return { post: (request) => queueMicrotask(() => handle(request)) };
}

function connect(): Port {
  if (port) return port;
  if (typeof Worker === "undefined") {
    port = local();
    return port;
  }
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "ranking",
  });
  worker.addEventListener("message", (event: MessageEvent<Update>) =>
    sessions.get(event.data.session)?.receive(event.data),
  );
  // It didn't load: rank on the page, starting the open sessions again.
  worker.addEventListener("error", () => {
    worker.terminate();
    port = local();
    for (const session of sessions.values()) session.replay();
  });
  // A worker's postMessage takes no target origin; nothing is transferred.
  port = { post: (request) => worker.postMessage(request, []) };
  return port;
}

// Starts the worker and warms the engine up. Cheap to call again.
let warmed = false;
export function warmRanking() {
  if (warmed) return;
  warmed = true;
  connect().post({ kind: "warm" });
}

export const emptyView: RankedView = { top: null, groups: [], total: 0 };

// One picker's ranking: streams in as each slice arrives, the ranked view
// out to `onView` after each one.
export class RankingSession {
  readonly #id = nextSession++;
  readonly #ctx: TitleContext;
  readonly #prefs: Prefs;
  readonly #onView: (view: RankedView, ms: number) => void;
  // Every stream added, by arrival number, and every slice to replay.
  readonly #arrived: { source: string; stream: Stream }[] = [];
  readonly #slices: { source: string; streams: Stream[] }[] = [];
  #pinned = false;
  #candidates = new Map<string, Candidate>();
  // What the engine hasn't answered yet, in order: each add and pin gets
  // one view back. Until no add is, the view is behind what was added.
  #owed: Request["kind"][] = [];

  constructor(ctx: TitleContext, prefs: Prefs, onView: (view: RankedView, ms: number) => void) {
    this.#ctx = ctx;
    this.#prefs = prefs;
    this.#onView = onView;
    sessions.set(this.#id, this);
    this.#open();
  }

  #open() {
    connect().post({ kind: "open", session: this.#id, ctx: this.#ctx, prefs: this.#prefs });
  }

  add(source: string, streams: readonly Stream[]) {
    const slice = { source, streams: [...streams] };
    this.#slices.push(slice);
    for (const stream of streams) this.#arrived.push({ source, stream });
    this.#owed.push("add");
    connect().post({ kind: "add", session: this.#id, ...slice });
  }

  // How many added slices the view hasn't ranked yet. A pin isn't one: it
  // only keeps the top pick where it is.
  get waiting() {
    return this.#owed.filter((kind) => kind === "add").length;
  }

  // The user started navigating: keep the highlighted pick where it is.
  pin() {
    if (this.#pinned) return;
    this.#pinned = true;
    this.#owed.push("pin");
    connect().post({ kind: "pin", session: this.#id });
  }

  close() {
    sessions.delete(this.#id);
    connect().post({ kind: "close", session: this.#id });
  }

  // Sends everything again, to a new engine.
  replay() {
    this.#candidates = new Map();
    // The old engine's answers aren't coming: everything is sent again.
    this.#owed = this.#slices.map(() => "add" as const);
    if (this.#pinned) this.#owed.push("pin");
    this.#open();
    for (const slice of this.#slices) {
      connect().post({ kind: "add", session: this.#id, ...slice });
    }
    if (this.#pinned) connect().post({ kind: "pin", session: this.#id });
  }

  receive(update: Update) {
    this.#owed.shift();
    for (const ranked of update.changed) this.#candidates.set(ranked.key, this.#hydrate(ranked));
    const known = (key: string) => this.#candidates.get(key)!;
    this.#onView(
      {
        top: update.top === null ? null : known(update.top),
        groups: update.groups.map(({ tier, keys }) => ({ tier, items: keys.map(known) })),
        total: update.total,
      },
      update.ms,
    );
  }

  #hydrate({ alternates, ...ranked }: Ranked): Candidate {
    return {
      ...ranked,
      stream: this.#arrived[ranked.seq]!.stream,
      alternates: alternates.map(({ source, seq }) => ({
        source,
        seq,
        stream: this.#arrived[seq]!.stream,
      })),
    };
  }
}
