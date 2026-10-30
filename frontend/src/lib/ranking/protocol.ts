import type { Stream } from "@/lib/addon-protocol";

import type { TitleContext } from "./context";
import { StreamEngine } from "./engine";
import { warmUp } from "./warm";
import type { Candidate, Prefs, Tier } from "./score";

// The messages between the page and the ranking worker (#51). Each picker
// is a session with its own engine. Streams go in once; what comes back
// names them by arrival number (`seq`), since the page keeps them, so an
// update carries only candidates that are new or changed and the order as
// keys.

export type Request =
  | { kind: "open"; session: number; ctx: TitleContext; prefs: Prefs }
  | { kind: "add"; session: number; source: string; streams: Stream[] }
  | { kind: "pin"; session: number }
  | { kind: "close"; session: number }
  | { kind: "warm" };

// A candidate without its streams.
export type Ranked = Omit<Candidate, "stream" | "alternates"> & {
  alternates: { source: string; seq: number }[];
};

export type Update = {
  session: number;
  changed: Ranked[];
  top: string | null;
  groups: { tier: Tier; keys: string[] }[];
  total: number;
  // How long the engine took, for measuring it where it runs.
  ms: number;
};

const strip = (c: Candidate): Ranked => ({
  key: c.key,
  source: c.source,
  seq: c.seq,
  parsed: c.parsed,
  verdict: c.verdict,
  score: c.score,
  tier: c.tier,
  alternates: c.alternates.map(({ source, seq }) => ({ source, seq })),
});

// Runs requests against the sessions' engines: in the worker, or on the page
// where there are no workers (tests).
export function serve(post: (update: Update) => void) {
  const engines = new Map<number, StreamEngine>();
  return (request: Request) => {
    if (request.kind === "warm") {
      warmUp();
      return;
    }
    const { session } = request;
    if (request.kind === "open") {
      engines.set(session, new StreamEngine(request.ctx, request.prefs));
      return;
    }
    if (request.kind === "close") {
      engines.delete(session);
      return;
    }
    const engine = engines.get(session);
    if (!engine) return;
    const start = performance.now();
    if (request.kind === "add") engine.add(request.source, request.streams);
    else engine.pinTop();
    const view = engine.view();
    const changed = engine.takeChanges().map(strip);
    post({
      session,
      changed,
      top: view.top?.key ?? null,
      groups: view.groups.map(({ tier, items }) => ({ tier, keys: items.map((c) => c.key) })),
      total: view.total,
      ms: performance.now() - start,
    });
  };
}
