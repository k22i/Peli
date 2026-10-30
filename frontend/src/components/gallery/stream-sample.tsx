import { useState } from "react";

import { GallerySection } from "@/components/gallery/gallery-section";
import { listRows, StreamList } from "@/components/streams/stream-list";
import { toastManager } from "@/components/ui/toast";
import type { Stream } from "@/lib/addon-protocol";
import { rankStreams, type Tier, type TitleContext } from "@/lib/ranking";

// A made-up film and what three made-up addons answer for it: one of each
// kind of stream the picker (#52) tells apart.
const film: TitleContext = {
  type: "movie",
  anime: false,
  id: "tt0000001",
  name: "The Lighthouse Keeper",
  year: 2024,
  runtimeMin: 118,
};
const hash = (n: number) => String(n).repeat(40).slice(0, 40);
const debrid = "https://debrid.example/manifest.json";
const torrents = "https://torrents.example/manifest.json";
const web = "https://web.example/manifest.json";

const answers: { source: string; streams: Stream[] }[] = [
  {
    source: debrid,
    streams: [
      {
        name: "[TB⚡] Debrid 2160p",
        description:
          "📄 The.Lighthouse.Keeper.2024.2160p.UHD.BluRay.REMUX.DV.HDR10.TrueHD.Atmos.7.1-GRP.mkv\n💾 61.2 GB\n🇬🇧",
      },
      {
        name: "[TB⚡] Debrid 1080p",
        description:
          "📄 The.Lighthouse.Keeper.2024.1080p.WEB-DL.DDP5.1.H.264-GRP.mkv\n💾 6.4 GB\n🇬🇧 / 🇫🇷",
      },
      {
        name: "[TB⬇️] Debrid 2160p",
        description:
          "📄 The.Lighthouse.Keeper.2024.2160p.WEB-DL.HDR10+.DDP5.1.H.265-GRP.mkv\n💾 18.9 GB",
      },
    ],
  },
  {
    source: torrents,
    streams: [
      {
        name: "Torrents\n1080p",
        title:
          "The.Lighthouse.Keeper.2024.1080p.BluRay.x264.DTS-HD.MA.5.1-GRP.mkv\n👤 112 💾 14.1 GB",
        infoHash: hash(1),
        fileIdx: 0,
      },
      {
        name: "Torrents\n720p",
        title: "The.Lighthouse.Keeper.2024.720p.WEBRip.AAC.2.0-GRP.mp4\n👤 34 💾 1.2 GB",
        infoHash: hash(2),
        fileIdx: 0,
      },
      {
        name: "Torrents\nCAM",
        title: "The.Lighthouse.Keeper.2024.HDCAM.x264-GRP.mkv\n👤 8 💾 1.4 GB",
        infoHash: hash(3),
        fileIdx: 0,
      },
      {
        name: "Torrents\n1080p",
        title: "The.Lighthouse.Keeper.2019.1080p.BluRay.x264-GRP.mkv\n👤 5 💾 9.8 GB",
        infoHash: hash(4),
        fileIdx: 0,
      },
    ],
  },
  { source: web, streams: [{ name: "Direct", title: "Watch", url: "https://web.example/play" }] },
];

const names = new Map([
  [debrid, "Debrid"],
  [torrents, "Torrents"],
  [web, "Direct"],
]);
const view = rankStreams(film, answers);

export function StreamSample() {
  const [open, setOpen] = useState<ReadonlySet<Tier>>(new Set());
  return (
    <GallerySection
      title="Stream picker"
      description="The best stream first, told by its badges: resolution, HDR and Dolby Vision, audio, source, size and whether it plays at once from a debrid cache. The file name shows only on request. CAM / TS and likely fakes stay collapsed."
      bleed
    >
      <StreamList
        rows={listRows(view, open)}
        names={names}
        onNavigate={() => {}}
        onPick={() => toastManager.add({ title: "Picked a stream" })}
        onToggleGroup={(tier) =>
          setOpen((current) => {
            const next = new Set(current);
            if (!next.delete(tier)) next.add(tier);
            return next;
          })
        }
      />
    </GallerySection>
  );
}
