import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

import { PosterCard } from "@/components/media/cards";
import { Row, rowLinkClassName } from "@/components/media/row";
import { statusOf, type Download } from "@/lib/downloads";
import { homeRowLimit } from "@/lib/home";
import { usePlay } from "@/lib/playback";
import { menuTitle } from "@/lib/title-actions";

// What Home's "Downloaded" row shows: the finished downloads, the most
// recently finished first, ten at most (homeRowLimit, as a catalog row,
// #113). A job that's still running has nothing to play yet, so it isn't
// here; the Downloads view (Library › Downloads) has every one of them.
export function finishedDownloads(downloads: readonly Download[]): Download[] {
  return downloads
    .filter((download) => statusOf(download) === "done")
    .toSorted((a, b) => b.doneAt - a.doneAt)
    .slice(0, homeRowLimit);
}

// "S1 · E2" under an episode's title, as Continue watching says it; a film's
// card has no second line.
const downloadedMeta = (download: Download) =>
  download.season > 0 ? `S${download.season} · E${download.episode}` : undefined;

// Home's "Downloaded" row (#85, ADR-0064, part 9): the titles this device
// holds, played through usePlay, which asks Go for the local file before it
// resolves anything (part 5). The cards open the title's menu as every other
// row's do, and "See all" opens the Downloads view.
export function DownloadedRow({ downloads }: { downloads: readonly Download[] }) {
  const play = usePlay();
  return (
    <Row
      title="Downloaded"
      action={
        <Link to="/library" search={{ view: "downloads" }} className={rowLinkClassName}>
          See all
          <ChevronRight aria-hidden />
        </Link>
      }
      items={downloads}
      getKey={(download) => download.id}
      card="poster"
      renderItem={(download) => (
        <PosterCard
          title={download.name}
          meta={downloadedMeta(download)}
          src={download.poster || undefined}
          menu={menuTitle({
            id: download.contentId,
            type: download.contentType,
            name: download.name,
            poster: download.poster || undefined,
          })}
          onClick={() =>
            play({
              type: download.contentType,
              id: download.contentId,
              title: download.name,
              videoId: download.videoId,
            })
          }
        />
      )}
    />
  );
}
