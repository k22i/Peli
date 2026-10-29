import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCanGoBack,
  useNavigate,
  useParams,
  useRouter,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import { Check, ChevronLeft, Clapperboard, Play, Plus, RotateCcw } from "lucide-react";

import type { Profile, WatchedItem } from "@bindings/store";
import { Service as Store } from "@bindings/store";
import { Notice } from "@/components/browse/browse-page";
import { Chip, ChipGroup } from "@/components/media/chip";
import { Hero, HeroSkeleton } from "@/components/media/hero";
import { CastList } from "@/components/title/cast-list";
import { EpisodeList } from "@/components/title/episode-list";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastManager } from "@/components/ui/toast";
import { addonsFor, metaQuery, type ContentType, type Meta } from "@/lib/addon-protocol";
import { useLoadedAddons } from "@/lib/home";
import { libraryQuery } from "@/lib/library";
import { usePlay } from "@/lib/playback";
import { currentProfileQuery } from "@/lib/profile";
import {
  episodeMarks,
  episodes as episodesOf,
  isAired,
  isSeriesType,
  libraryItem,
  mainEpisodes,
  playChoice,
  seasonLabel,
  seasons as seasonsOf,
  seriesMarkChange,
  titleMark,
  titleMetaQuery,
  titleProgressQuery,
  titleState,
  titleWatchedQuery,
  type Episode,
  type TitlePreview,
  type TitleSearch,
} from "@/lib/title";
import { tmdbRef, useTmdbArt, type TmdbArt } from "@/lib/tmdb";

// A title's page (#45): its art, details and cast, Play or Resume, the
// library and watched toggles, and for a series its seasons and episodes.
// It paints from the card it was opened from, then from the details' cache,
// then fills in. Watched state follows Nuvio's apps (ADR-0029). With a TMDB
// key, TMDB's logo, backdrop and cast photos replace the addon's (ADR-0031).
export function TitlePage() {
  const { type, id } = useParams({ from: "/title/$type/$id" });
  const profile = useQuery(currentProfileQuery).data;
  const passed = useRouterState({ select: (state) => state.location.state.title });
  const preview = passed?.id === id && passed.type === type ? passed : undefined;

  return (
    <div className="relative flex flex-col gap-10 pb-12">
      <BackButton />
      {profile ? (
        <Title profile={profile} type={type} id={id} preview={preview} />
      ) : (
        <HeroSkeleton className={heroOffset} />
      )}
    </div>
  );
}

// Flush with the top of the page, as on Home.
const heroOffset = "-mb-4";

function BackButton() {
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      aria-label="Back"
      onClick={() => (canGoBack ? router.history.back() : void navigate({ to: "/" }))}
      className="glass absolute start-[calc(var(--spacing-gutter)+0.5rem)] top-6 z-10 rounded-full bg-popover/80 text-popover-foreground hover:bg-popover dark:start-gutter dark:top-4"
    >
      <ChevronLeft className="size-5" />
    </Button>
  );
}

function Title({
  profile,
  type,
  id,
  preview,
}: {
  profile: Profile;
  type: ContentType;
  id: string;
  preview: TitlePreview | undefined;
}) {
  const client = useQueryClient();
  const { visible, addons, loading } = useLoadedAddons(profile.id);
  const details = useQuery({
    ...titleMetaQuery(addons, type, id),
    enabled: !loading,
    // A title seen before: its details from the cache at once.
    initialData: () => {
      for (const addon of addonsFor(addons, "meta", type, id)) {
        const cached = client.getQueryData(metaQuery(addon.url, type, id).queryKey);
        if (cached) return { addonUrl: addon.url, meta: cached.meta };
      }
      return undefined;
    },
  });

  const meta = details.data?.meta;
  // An IMDb or TMDB id is looked up at once, beside the addon; a Kitsu id
  // waits for the details' imdb_id.
  const art = useTmdbArt(tmdbRef(type, id, meta));
  const shown = meta ?? preview;
  if (!shown) {
    if (details.isError || visible.data?.length === 0) {
      return <LoadFailed onRetry={() => void details.refetch()} />;
    }
    return <HeroSkeleton className={heroOffset} />;
  }
  return (
    <>
      {meta && details.data ? (
        <LoadedTitle profile={profile} meta={meta} addonUrl={details.data.addonUrl} art={art} />
      ) : (
        <Hero
          className={heroOffset}
          title={shown.name}
          logo={art?.logo}
          meta={shown.releaseInfo ? [shown.releaseInfo] : []}
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
}: {
  profile: Profile;
  meta: Meta;
  addonUrl: string;
  art: TmdbArt | undefined;
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
        className={heroOffset}
        title={meta.name}
        logo={art?.logo ?? meta.logo}
        meta={metaLine(meta)}
        synopsis={meta.description}
        {...backdrops(meta, art)}
        actions={
          <>
            {choice && (
              <Button size="lg" onClick={() => play(choice.target)}>
                {choice.resume ? <RotateCcw /> : <Play className="fill-current" />}
                {choice.label}
              </Button>
            )}
            <Button
              size="lg"
              variant="secondary"
              disabled={library === undefined || toggleLibrary.isPending}
              onClick={() => toggleLibrary.mutate()}
            >
              {saved ? <Check /> : <Plus />}
              {saved ? "In library" : "Add to library"}
            </Button>
            <Button
              size="lg"
              variant="secondary"
              disabled={setWatched.isPending || (series && mainEpisodes(list).length === 0)}
              onClick={toggleWatched}
            >
              <Check className={watched ? "text-brand" : undefined} />
              {watched ? "Watched" : "Mark watched"}
            </Button>
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

// "2008–2013 · 49 min · Crime, Drama, Thriller · IMDb 9.5"
function metaLine(meta: Meta): string[] {
  return [
    meta.releaseInfo,
    meta.runtime,
    (meta.genres ?? []).slice(0, 3).join(", "),
    meta.imdbRating && `IMDb ${meta.imdbRating}`,
  ].filter((item): item is string => Boolean(item));
}

function Episodes({
  meta,
  list,
  state,
  next,
  busy,
  onMark,
  onPlay,
}: {
  meta: Meta;
  list: Episode[];
  state: ReturnType<typeof titleState>;
  next: string | undefined;
  busy: boolean;
  onMark: (items: WatchedItem[], watched: boolean) => void;
  onPlay: (episode: Episode) => void;
}) {
  const navigate = useNavigate();
  const search: TitleSearch = useSearch({ strict: false });
  const seasons = seasonsOf(list);
  // The season asked for, else the one Play would play from, else the first.
  const season =
    (search.season !== undefined && seasons.includes(search.season) ? search.season : undefined) ??
    list.find((episode) => episode.id === next)?.season ??
    seasons[0]!;
  const shown = list.filter((episode) => episode.season === season);
  const aired = shown.filter((episode) => isAired(episode));
  const seasonWatched = aired.length > 0 && aired.every((episode) => state.watched(episode));
  // Replaced, not pushed: Back leaves the page rather than walking seasons.
  const choose = (picked: number) =>
    void navigate({ to: ".", search: { season: picked }, replace: true, resetScroll: false });

  return (
    <section aria-labelledby="episodes" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-gutter">
        <h2 id="episodes" className="font-heading text-heading font-stretch-semi-expanded">
          Episodes
        </h2>
        {seasons.length > 1 && seasons.length <= 8 ? (
          <ChipGroup
            aria-label="Seasons"
            value={[String(season)]}
            onValueChange={(value: string[]) => {
              const [picked] = value;
              if (picked !== undefined) choose(Number(picked));
            }}
          >
            {seasons.map((number) => (
              <Chip key={number} value={String(number)}>
                {seasonLabel(number)}
              </Chip>
            ))}
          </ChipGroup>
        ) : (
          seasons.length > 1 && <SeasonSelect seasons={seasons} value={season} onChange={choose} />
        )}
        <Button
          variant="ghost"
          className="ms-auto"
          disabled={busy || aired.length === 0}
          onClick={() => onMark(episodeMarks(meta, aired), !seasonWatched)}
        >
          <Check className={seasonWatched ? "text-brand" : undefined} />
          {seasonWatched ? "Mark season unwatched" : "Mark season watched"}
        </Button>
      </div>
      <EpisodeList
        key={season}
        label={seasonLabel(season)}
        episodes={shown}
        state={state}
        busy={busy}
        onPlay={onPlay}
        onMark={(episode, watched) => onMark(episodeMarks(meta, [episode]), watched)}
        onMarkEarlier={(episode, watched) => {
          const main = mainEpisodes(list);
          const earlier = main.slice(0, main.indexOf(episode));
          onMark(episodeMarks(meta, earlier), watched);
        }}
        earlier={(episode) => {
          const main = mainEpisodes(list);
          const index = main.indexOf(episode);
          if (index <= 0) return undefined;
          return main.slice(0, index).every((before) => state.watched(before));
        }}
      />
    </section>
  );
}

function SeasonSelect({
  seasons,
  value,
  onChange,
}: {
  seasons: number[];
  value: number;
  onChange: (season: number) => void;
}) {
  const items = seasons.map((number) => ({ value: String(number), label: seasonLabel(number) }));
  return (
    <Select
      items={items}
      value={String(value)}
      onValueChange={(next) => next !== null && onChange(Number(next))}
    >
      <SelectTrigger aria-label="Season" className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

// Cast and crew, as the addon names them. The cast has its own strip, with
// photos, when TMDB lists it (#47).
function About({ meta, withCast }: { meta: Meta; withCast: boolean }) {
  const rows = [
    ["Cast", withCast ? meta.cast : undefined],
    ["Directed by", meta.director],
    ["Written by", meta.writer],
    ["Genres", meta.genres],
    ["Country", meta.country ? [meta.country] : undefined],
    ["Awards", meta.awards ? [meta.awards] : undefined],
  ].flatMap(([label, values]) =>
    Array.isArray(values) && values.length > 0 ? [{ label: String(label), values }] : [],
  );
  if (rows.length === 0 && !meta.description) return null;
  return (
    <section aria-labelledby="about" className="flex max-w-4xl flex-col gap-4 px-gutter">
      <h2 id="about" className="font-heading text-heading font-stretch-semi-expanded">
        About
      </h2>
      {meta.description && (
        <p className="max-w-prose text-pretty text-muted-foreground">{meta.description}</p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        {rows.map(({ label, values }) => (
          <div key={label} className="contents">
            <dt className="font-mono text-meta text-muted-foreground uppercase">{label}</dt>
            <dd>{values.join(", ")}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
