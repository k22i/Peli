import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouterState } from "@tanstack/react-router";
import { Check, Clapperboard, Eye, EyeOff, Film, Play, Plus, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import type { Profile, WatchedItem } from "@bindings/store";
import { Notice } from "@/components/browse/browse-page";
import { Hero, HeroSkeleton, ImdbScore, MetaLine } from "@/components/media/hero";
import { usePullToRefresh } from "@/components/shell/pull-to-refresh";
import { About } from "@/components/title/about";
import { BackButton } from "@/components/title/back-button";
import { CastList } from "@/components/title/cast-list";
import { Episodes } from "@/components/title/episodes";
import { RoundAction } from "@/components/title/round-action";
import { TrackingActions } from "@/components/title/tracking-actions";
import { RelatedRows } from "@/components/title/related-rows";
import { Button } from "@/components/ui/button";
import type { ContentType, Meta } from "@/lib/addon-protocol";
import { useLoadedAddons } from "@/lib/home";
import { libraryQuery } from "@/lib/library";
import { openURL } from "@/lib/open-url";
import { usePlay } from "@/lib/playback";
import { currentProfileQuery } from "@/lib/profile";
import { warmRanking } from "@/lib/ranking";
import {
  cachedTitleMeta,
  episodeMarks,
  episodeTarget,
  episodes as episodesOf,
  isSeriesType,
  libraryItem,
  mainEpisodes,
  playChoice,
  titleMark,
  titleMetaQuery,
  titleProgressQuery,
  titleState,
  titleWatchedQuery,
  type TitlePreview,
} from "@/lib/title";
import { useTitleEdits } from "@/lib/title-actions";
import { tmdbRef, useTmdbArt, type TmdbArt } from "@/lib/tmdb";

// A title's page (#45, redesigned in #117): its art under the material-pop chrome,
// details and cast, Play or Resume, the library and watched toggles, and for
// a series its seasons and episodes. It paints from the card it was opened
// from, then from the details' cache, then fills in. Watched state follows
// Nuvio's apps (ADR-0029). With a TMDB key, TMDB's logo, backdrop and cast
// photos replace the addon's (ADR-0031).
export function TitlePage() {
  const { type, id } = useParams({ from: "/title/$type/$id" });
  const profile = useQuery(currentProfileQuery).data;
  const passed = useRouterState({ select: (state) => state.location.state.title });
  const preview = passed?.id === id && passed.type === type ? passed : undefined;
  // The hero, for the Back button to watch scroll away.
  const [hero, setHero] = useState<HTMLElement | null>(null);

  return (
    <div className="relative flex flex-col gap-14 pb-20">
      <BackButton hero={hero} />
      {profile ? (
        <Title profile={profile} type={type} id={id} preview={preview} heroRef={setHero} />
      ) : (
        <HeroSkeleton size="title" />
      )}
    </div>
  );
}

function Title({
  profile,
  type,
  id,
  preview,
  heroRef,
}: {
  profile: Profile;
  type: ContentType;
  id: string;
  preview: TitlePreview | undefined;
  heroRef: (hero: HTMLElement | null) => void;
}) {
  const client = useQueryClient();
  const { visible, addons, loading } = useLoadedAddons(profile.id);
  const details = useQuery({
    ...titleMetaQuery(addons, type, id),
    enabled: !loading,
    // A title seen before: its details from the cache at once.
    ...cachedTitleMeta(client, addons, type, id),
  });

  const meta = details.data?.meta;
  // An IMDb or TMDB id is looked up at once, beside the addon; a Kitsu id
  // waits for the details' imdb_id.
  const art = useTmdbArt(tmdbRef(type, id, meta));
  // Pull to refresh on iOS (#135): the addon's details and TMDB's.
  usePullToRefresh(() =>
    Promise.all([
      details.refetch(),
      client.invalidateQueries({ queryKey: ["tmdb"], refetchType: "active" }),
    ]),
  );
  // Play is a click away: get the ranking engine's slow first run over.
  useEffect(warmRanking, []);
  const shown = meta ?? preview;
  if (!shown) {
    if (details.isError || visible.data?.length === 0) {
      return <LoadFailed onRetry={() => void details.refetch()} />;
    }
    return <HeroSkeleton size="title" />;
  }
  return (
    <>
      {meta && details.data ? (
        <LoadedTitle
          profile={profile}
          meta={meta}
          addonUrl={details.data.addonUrl}
          art={art}
          heroRef={heroRef}
        />
      ) : (
        <Hero
          ref={heroRef}
          size="title"
          title={shown.name}
          logo={art?.logo}
          meta={shown.releaseInfo ? [<span key="year">{shown.releaseInfo}</span>] : []}
          synopsis={shown.description}
          {...backdrops(shown, art)}
        />
      )}
      {!meta && details.isError && <LoadFailed onRetry={() => void details.refetch()} />}
    </>
  );
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="pt-16">
      <Notice
        icon={Clapperboard}
        title="Couldn’t load this title"
        description="None of your addons answered for it. They may be down, or you may be offline."
        action={<Button onClick={onRetry}>Try again</Button>}
      />
    </div>
  );
}

function LoadedTitle({
  profile,
  meta,
  addonUrl,
  art,
  heroRef,
}: {
  profile: Profile;
  meta: Meta;
  addonUrl: string;
  art: TmdbArt | undefined;
  heroRef: (hero: HTMLElement | null) => void;
}) {
  const play = usePlay();
  const marks = useQuery(titleWatchedQuery(profile.id, meta.id)).data ?? [];
  const progress = useQuery(titleProgressQuery(profile.id, meta.id)).data ?? [];
  const library = useQuery(libraryQuery(profile.id)).data;
  const state = titleState(meta, marks, progress);
  const choice = playChoice(meta, state, progress);
  const series = isSeriesType(meta.type);
  const list = episodesOf(meta);
  const saved = library?.some(
    (item) => item.contentId === meta.id && item.contentType === meta.type,
  );

  const { setWatched, saveToLibrary, removeFromLibrary, clearProgress } = useTitleEdits(profile.id);
  const mark = (items: WatchedItem[], watched: boolean) =>
    setWatched.mutate({ meta, items, watched });
  const toggleLibrary = () =>
    saved
      ? removeFromLibrary.mutate({ contentId: meta.id, contentType: meta.type, name: meta.name })
      : saveToLibrary.mutate(libraryItem(meta, addonUrl));

  const watched = series ? state.seriesWatched : state.watched();
  const toggleWatched = () => {
    if (!series) return mark([titleMark(meta)], !watched);
    return mark([titleMark(meta), ...episodeMarks(meta, mainEpisodes(list))], !watched);
  };

  return (
    <>
      <Hero
        ref={heroRef}
        size="title"
        // The hero's fade already ends at its bottom edge, so the page's own
        // gap would show as a blank band under it (worst in light mode).
        className="-mb-8"
        title={meta.name}
        logo={art?.logo ?? meta.logo}
        meta={[<TitleMeta key="meta" meta={meta} art={art} />]}
        metaRaw
        synopsis={meta.description}
        {...backdrops(meta, art)}
        actions={
          <>
            {choice && (
              <Button
                size="xl"
                variant="light"
                className="min-w-40"
                onClick={() => play(choice.target)}
              >
                {choice.resume ? <RotateCcw /> : <Play className="fill-current" />}
                {choice.label}
              </Button>
            )}
            <RoundAction
              label={saved ? "In library" : "Add to library"}
              disabled={
                library === undefined || saveToLibrary.isPending || removeFromLibrary.isPending
              }
              onClick={toggleLibrary}
            >
              {saved ? <Check /> : <Plus />}
            </RoundAction>
            <RoundAction
              label={watched ? "Watched" : "Mark watched"}
              disabled={setWatched.isPending || (series && mainEpisodes(list).length === 0)}
              onClick={toggleWatched}
            >
              {watched ? <EyeOff /> : <Eye />}
            </RoundAction>
            <TrackingActions profile={profile} meta={meta} />
            {/* YouTube opens in the system browser; the player isn't involved.
                A kids profile doesn't leave the app. */}
            {art?.trailer && !profile.kids && (
              <RoundAction
                label="Trailer"
                disabled={false}
                onClick={() => void openURL(art.trailer!)}
              >
                <Film />
              </RoundAction>
            )}
          </>
        }
      />
      {series && list.length > 0 && (
        <Episodes
          meta={meta}
          list={list}
          state={state}
          next={choice?.target.videoId}
          busy={setWatched.isPending}
          onMark={mark}
          onPlay={(episode) =>
            play(episodeTarget(meta, episode, state.progress(episode)?.position))
          }
          onPlayFromStart={(episode) => play({ ...episodeTarget(meta, episode), startOver: true })}
          onClearProgress={(episode) => {
            const entry = state.progress(episode);
            if (entry) clearProgress.mutate({ contentId: meta.id, keys: [entry.key] });
          }}
        />
      )}
      {art && art.cast.length > 0 && <CastList cast={art.cast} />}
      <About meta={meta} withCast={!art || art.cast.length === 0} art={art} />
      {art && !profile.kids && <RelatedRows art={art} />}
    </>
  );
}

// TMDB's backdrop over the addon's, which shows while it loads or if it
// fails.
function backdrops(
  shown: { background?: string | undefined; poster?: string | undefined },
  art: TmdbArt | undefined,
) {
  const own = shown.background ?? shown.poster;
  return art?.backdrop
    ? { backdrop: art.backdrop, fallbackBackdrop: own }
    : { backdrop: own, fallbackBackdrop: undefined };
}

// "2008–2013 · 49 min · Crime, Drama, Thriller · TV-MA · IMDb 8.4 · TMDB 8.9".
function TitleMeta({ meta, art }: { meta: Meta; art: TmdbArt | undefined }) {
  const items = [meta.releaseInfo, meta.runtime, (meta.genres ?? []).slice(0, 3).join(", ")]
    .filter(Boolean)
    .map((text) => <span key={text}>{text}</span>);
  if (art?.certificate) {
    items.push(
      <span
        key="certificate"
        data-testid="certificate"
        className="rounded-[3px] px-1 py-px text-[0.6875rem] leading-none font-semibold text-white/85 ring-1 ring-white/45"
      >
        {art.certificate}
      </span>,
    );
  }
  if (meta.imdbRating) items.push(<ImdbScore key="imdb" rating={meta.imdbRating} />);
  if (art?.score) items.push(<TmdbScore key="tmdb" rating={art.score} />);
  return <MetaLine items={items} className="text-[0.8125rem]" />;
}

// TMDB's own teal tag, then the score.
function TmdbScore({ rating }: { rating: string }) {
  return (
    <span data-testid="tmdb-score" className="inline-flex items-center gap-1.5">
      <span className="rounded-[3px] bg-[#01b4e4] px-1 py-px text-[0.5625rem] leading-none font-black tracking-tight text-black">
        TMDB
      </span>{" "}
      {rating}
    </span>
  );
}
