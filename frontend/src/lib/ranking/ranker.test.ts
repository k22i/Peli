import { describe, expect, it, vi } from "vite-plus/test";

import type { Stream } from "@/lib/addon-protocol";

import type { TitleContext } from "./context";
import type { RankedView } from "./engine";
import { RankingSession } from "./ranker";
import { defaultPrefs } from "./score";

// jsdom has no workers, so these run the engine on the page, through the
// same messages the worker takes.

const movie: TitleContext = {
  type: "movie",
  anime: false,
  id: "tt1",
  name: "Some Film",
  year: 2024,
};
const hash = (n: number) => String(n).repeat(40);
const stream = (file: string, infoHash: string, name = "Torrentio\n1080p"): Stream => ({
  name,
  description: `${file}\n👤 10 💾 2 GB`,
  infoHash,
  behaviorHints: { filename: file },
});

function session() {
  const views: RankedView[] = [];
  const ranking = new RankingSession(movie, defaultPrefs, (view) => views.push(view));
  const latest = () => views.at(-1)!;
  return { ranking, views, latest };
}

describe("RankingSession", () => {
  it("hands back the ranked view with each candidate's own streams", async () => {
    const { ranking, latest } = session();
    const p2p = stream("Some.Film.2024.720p.WEB-DL.H264-GRP.mkv", hash(1));
    const debrid = stream("Some.Film.2024.720p.WEB-DL.H264-GRP.mkv", hash(1), "[TB+] Torrentio");
    const better = stream("Some.Film.2024.2160p.WEB-DL.H265-GRP.mkv", hash(2));
    ranking.add("torrentio", [p2p, better]);
    ranking.add("torrentio-tb", [debrid]);
    await vi.waitFor(() => expect(latest().total).toBe(2));
    const { top, groups } = latest();
    expect(top?.stream).toBe(debrid);
    expect(top?.alternates.map((a) => a.stream)).toEqual([p2p]);
    expect(groups.map((g) => g.items.map((c) => c.stream))).toEqual([[better], [debrid]]);
    ranking.close();
  });

  it("keeps the top pick once pinned", async () => {
    const { ranking, latest } = session();
    ranking.add("a", [stream("Some.Film.2024.720p.WEB-DL.H264-GRP.mkv", hash(1))]);
    await vi.waitFor(() => expect(latest().total).toBe(1));
    const first = latest().top?.key;
    ranking.pin();
    ranking.add("b", [stream("Some.Film.2024.2160p.WEB-DL.H265-GRP.mkv", hash(2), "[TB+] B")]);
    await vi.waitFor(() => expect(latest().total).toBe(2));
    expect(latest().top?.key).toBe(first);
    ranking.close();
  });

  it("ranks everything again from the start when replayed", async () => {
    const { ranking, latest } = session();
    ranking.add("a", [stream("Some.Film.2024.720p.WEB-DL.H264-GRP.mkv", hash(1))]);
    ranking.add("b", [stream("Some.Film.2024.1080p.WEB-DL.H264-GRP.mkv", hash(2))]);
    await vi.waitFor(() => expect(latest().total).toBe(2));
    ranking.replay();
    await vi.waitFor(() => expect(latest().total).toBe(2));
    expect(latest().groups.map((g) => g.tier)).toEqual(["1080p", "720p"]);
    ranking.close();
  });

  it("stops answering once closed", async () => {
    const { ranking, views } = session();
    ranking.close();
    ranking.add("a", [stream("Some.Film.2024.720p.WEB-DL.H264-GRP.mkv", hash(1))]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(views).toEqual([]);
  });
});
