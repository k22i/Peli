import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouterState } from "@tanstack/react-router";
import { Check, Clapperboard, Eye, EyeOff, Play, Plus, RotateCcw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { Profile, WatchedItem } from "@bindings/store";
import { Service as Store } from "@bindings/store";
import { Notice } from "@/components/browse/browse-page";
import { Hero, HeroSkeleton, ImdbScore, MetaLine } from "@/components/media/hero";
import { About } from "@/components/title/about";
import { BackButton } from "@/components/title/back-button";
import { CastList } from "@/components/title/cast-list";
import { Episodes } from "@/components/title/episodes";
import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { ContentType, Meta } from "@/lib/addon-protocol";
import { useLoadedAddons } from "@/lib/home";
import { libraryQuery } from "@/lib/library";
import { usePlay } from "@/lib/playback";
import { currentProfileQuery } from "@/lib/profile";
import { warmRanking } from "@/lib/ranking";
import {
  cachedTitleMeta,
  episodeMarks,
  episodes as episodesOf,
  isSeriesType,
  libraryItem,
  mainEpisodes,
  playChoice,
  seriesMarkChange,
  titleMark,
  titleMetaQuery,
  titleProgressQuery,
  titleState,
  titleWatchedQuery,
  type TitlePreview,
} from "@/lib/title";
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
  const client = useQueryClient();
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

  // Marks or unmarks, then keeps the series-level mark in step with the
  // episodes, as Nuvio's apps do.
  const setWatched = useMutation({
    mutationFn: async ({ items, watched }: { items: WatchedItem[]; watched: boolean }) => {
      await Store.SetWatched(profile.id, items, watched);
      if (!series) return;
      const [nowMarks, nowProgress] = await Promise.all([
        Store.TitleWatched(profile.id, meta.id),
        Store.TitleProgress(profile.id, meta.id),
      ]);
      const change = seriesMarkChange(meta, titleState(meta, nowMarks ?? [], nowProgress ?? []));
      if (change !== undefined) await Store.SetWatched(profile.id, [titleMark(meta)], change);
    },
    onError: () => toastManager.add({ type: "error", title: "Couldn’t save that" }),
    onSettled: () =>
      Promise.all(
        ["watched", "progress", "continue-watching", "last-watched"].map((prefix) =>
          client.invalidateQueries({ queryKey: [prefix, profile.id] }),
        ),
      ),
  });
  const mark = (items: WatchedItem[], watched: boolean) => setWatched.mutate({ items, watched });

  const toggleLibrary = useMutation({
    mutationFn: () =>
      saved
        ? Store.RemoveLibraryItem(profile.id, meta.id, meta.type)
        : Store.SaveLibraryItem(profile.id, libraryItem(meta, addonUrl)),
    onError: () => toastManager.add({ type: "error", title: "Couldn’t update your library" }),
    onSettled: () => client.invalidateQueries({ queryKey: ["library", profile.id] }),
  });

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
        meta={[<TitleMeta key="meta" meta={meta} />]}
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
              disabled={library === undefined || toggleLibrary.isPending}
              onClick={() => toggleLibrary.mutate()}
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
          onPlay={(episode) => {
            const entry = state.progress(episode);
            play({
              type: meta.type,
              id: meta.id,
              title: `${meta.name} S${episode.season} · E${episode.episode}`,
              videoId: episode.id,
              resumeAt: entry?.position,
            });
          }}
        />
      )}
      {art && art.cast.length > 0 && <CastList cast={art.cast} />}
      <About meta={meta} withCast={!art || art.cast.length === 0} />
    </>
  );
}

// A round media-glass icon button with a tooltip. The label is the button's
// accessible name, as the text buttons it replaced had.
function RoundAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="media"
            size="icon-xl"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
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

// "2008–2013 · 49 min · Crime, Drama, Thriller · IMDb 8.4".
function TitleMeta({ meta }: { meta: Meta }) {
  const items = [meta.releaseInfo, meta.runtime, (meta.genres ?? []).slice(0, 3).join(", ")]
    .filter(Boolean)
    .map((text) => <span key={text}>{text}</span>);
  if (meta.imdbRating) items.push(<ImdbScore key="imdb" rating={meta.imdbRating} />);
  return <MetaLine items={items} className="text-[0.8125rem]" />;
}
