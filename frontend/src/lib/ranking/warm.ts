import type { Stream } from "@/lib/addon-protocol";

import { rankStreams } from "./engine";

// The engine's first run takes 26–29 ms while the JIT warms up (#6), several
// times a warm one. Ranking a made-up answer when a title page opens gets
// that out of the way before the picker needs it.

const names = [
  "Some.Film.2024.2160p.UHD.BluRay.REMUX.DV.HDR10.HEVC.TrueHD.7.1.Atmos-GRP.mkv",
  "Some.Film.2024.1080p.WEB-DL.DDP5.1.H.264-GRP.mkv",
  "Some Film (2024) [720p] [BluRay] [YTS.MX].mp4",
  "[Group] Some Show - 01 (1080p HEVC AAC) [ABCDEF12].mkv",
  "Some.Show.S01E01.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRP.mkv",
  "Some Film 2024 HDCAM x264 AAC.mkv",
];

const sample: Stream[] = Array.from({ length: 60 }, (_, i) => {
  const file = names[i % names.length]!;
  return i % 2
    ? {
        name: `[TB${i % 4 === 1 ? "+" : " download"}] Torrentio\n1080p`,
        title: `${file}\n👤 ${i * 7} 💾 ${(i % 9) + 1}.${i % 10} GB ⚙️ Tracker\n🇬🇧 / 🇮🇹`,
        url: `https://example.invalid/resolve/torbox/key/${i.toString(16).padStart(40, "0")}/null/0/${file}`,
        behaviorHints: { bingeGroup: `torrentio|${i}`, filename: file },
      }
    : {
        name: `[TB${i % 4 ? "⚡" : "⬇️"}] Comet 2160p`,
        description: `📄 ${file}\n📹 hevc | 🔊 TrueHD\n💾 ${(i % 30) + 1} GB 🔎 DMM`,
        behaviorHints: {
          bingeGroup: `comet|torbox|${(i + 1).toString(16).padStart(40, "0")}`,
          filename: file,
          videoSize: ((i % 30) + 1) * 2 ** 30,
        },
      };
});

export function warmUp() {
  for (const type of ["movie", "series"] as const) {
    rankStreams({ type, anime: false, id: "tt0000000:1:1", name: "Some Film", runtimeMin: 120 }, [
      { source: "warm-up", streams: sample },
    ]);
  }
}
