import { expect, it } from "vite-plus/test";

import { parseStreamResponse } from "@/lib/addon-protocol/parse";

import { labelled } from "./accuracy";
import corpus from "./corpus/labelled.json";
import { StreamEngine } from "./engine";

// Times the ranking engine (#51) on the whole recorded corpus of #6 (20
// titles, five addon setups, 20,453 streams), not only its labelled part.
// Skipped unless asked for. It runs on V8, WebView2's engine; Vitest doesn't
// run under Bun, so JavaScriptCore (WKWebView, WebKitGTK) was timed with the
// same loop in a plain Bun script (ADR-0035).
//
//   RANKING_TIMING=1 vp test run src/lib/ranking/timing.test.ts --silent=false
//
// The target is ~200 streams in one frame, 16 ms at p95, on the reference
// machine (an M1 Pro), and each 150-stream slice well within it. Times
// depend on the machine and what else it's doing, so CI doesn't run this.

type Fixture = { title: string; ms: number; addon: string; streams: unknown[] };
const fixtures = import.meta.glob<Fixture>("../../../../spikes/stream-ranking/fixtures/*/*.json", {
  import: "default",
});

// As lib/streams.ts feeds the engine.
const sliceSize = 150;
const slices = <T>(list: readonly T[]) =>
  Array.from({ length: Math.ceil(list.length / sliceSize) }, (_, i) =>
    list.slice(i * sliceSize, (i + 1) * sliceSize),
  );

const time = (run: () => void) => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

const round = (ms: number) => Math.round(ms * 100) / 100;

const stats = (ms: readonly number[]) => {
  const sorted = ms.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return {
    n: sorted.length,
    median: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1)!),
  };
};

const rounds = 15;

it.runIf(import.meta.env["RANKING_TIMING"])(
  "ranks ~200 streams within a frame",
  async () => {
    const recorded = await Promise.all(Object.values(fixtures).map((load) => load()));
    // The contexts the labels were judged against, by title, and each
    // title's answers in the order they came (fastest addon first).
    const contexts = new Map(
      labelled(corpus).map((row) => [row.id.replace(/^[^/]+\/([^#]+)#.*/, "$1"), row.ctx]),
    );
    const titles = [...contexts].map(([slug, ctx]) => ({
      ctx,
      answers: recorded
        .filter((fixture) => fixture.title === slug)
        .toSorted((a, b) => a.ms - b.ms)
        .map((fixture) => ({
          source: fixture.addon,
          streams: parseStreamResponse({ streams: fixture.streams }).streams,
        })),
    }));

    // The first run, before the JIT has seen the code.
    const first = titles[0]!;
    const cold = time(() => {
      const engine = new StreamEngine(first.ctx);
      engine.add("all", first.answers.flatMap((answer) => answer.streams).slice(0, 200));
      engine.view();
    });

    const at200: number[] = [];
    const sliced: number[] = [];
    const whole: number[] = [];
    for (let pass = 0; pass < rounds; pass++) {
      for (const { ctx, answers } of titles) {
        const all = answers.flatMap((answer) => answer.streams);
        at200.push(
          time(() => {
            const engine = new StreamEngine(ctx);
            engine.add("all", all.slice(0, 200));
            engine.view();
          }),
        );
        const engine = new StreamEngine(ctx);
        let total = 0;
        for (const { source, streams } of answers) {
          for (const slice of slices(streams)) {
            const ms = time(() => {
              engine.add(source, slice);
              engine.view();
            });
            sliced.push(ms);
            total += ms;
          }
        }
        whole.push(total);
      }
    }

    const { bun, node } = process.versions;
    console.log(bun ? `JavaScriptCore (Bun ${bun})` : `V8 (Node ${node})`);
    console.log("cold, ~200 streams, ms:", round(cold));
    console.log("~200 streams at once, ms:", stats(at200));
    console.log(`one ${sliceSize}-stream slice and the view, ms:`, stats(sliced));
    console.log("a whole title in slices, ms:", stats(whole));
    expect(stats(at200).p95).toBeLessThanOrEqual(16);
  },
  120_000,
);
