import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useCanGoBack,
  useNavigate,
  useParams,
  useRouter,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, Check, ChevronLeft, Puzzle } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import type { Profile } from "@bindings/store";
import { Notice } from "@/components/browse/browse-page";
import { scrollParent } from "@/components/media/poster-grid";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import type { ContentType } from "@/lib/addon-protocol";
import { useLoadedAddons } from "@/lib/home";
import { streamId, type PlayTarget, type StreamsSearch } from "@/lib/playback";
import { currentProfileQuery } from "@/lib/profile";
import {
  collapsedTiers,
  titleContext,
  type Candidate,
  type RankedView,
  type Tier,
} from "@/lib/ranking";
import { profileSettingsQuery } from "@/lib/settings";
import {
  rankingPrefs,
  useRankedStreams,
  useStreamAddons,
  useStreams,
  type StreamSource,
} from "@/lib/streams";
import { cachedTitleMeta, titleMetaQuery } from "@/lib/title";

// The stream picker (#50): every stream addon asked at once, each with its
// own state, and their streams ranked as they arrive (#51), the top pick
// first and likely fakes and CAM / TS collapsed. Leaving it aborts the
// requests still out. Until the ranked picker (#52) lands, the list is
// plain; picking a stream says the player (#60) isn't built yet.
export function StreamsPage() {
  const { type, id } = useParams({ from: "/streams/$type/$id" });
  const search: StreamsSearch = useSearch({ from: "/streams/$type/$id" });
  const profile = useQuery(currentProfileQuery).data;
  const passed = useRouterState({ select: (state) => state.location.state.play });
  const video = streamId({ id, videoId: search.video });
  const target: PlayTarget =
    passed?.id === id && streamId(passed) === video
      ? passed
      : { type, id, title: "Streams", videoId: search.video, resumeAt: search.at };

  return (
    <div className="flex flex-col gap-6 py-6">
      <div className="flex items-center gap-3 px-gutter">
        <BackButton />
        <h1 className="font-heading text-title font-stretch-semi-expanded">{target.title}</h1>
      </div>
      {profile ? (
        <Picker
          key={`${type}/${video}`}
          profile={profile}
          type={type}
          video={video}
          target={target}
        />
      ) : (
        <Asking />
      )}
    </div>
  );
}

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
      className="rounded-full"
    >
      <ChevronLeft className="size-5" />
    </Button>
  );
}

function Asking() {
  return (
    <div className="flex justify-center py-12">
      <Spinner className="size-6 text-muted-foreground" />
    </div>
  );
}

function Picker({
  profile,
  type,
  video,
  target,
}: {
  profile: Profile;
  type: ContentType;
  video: string;
  target: PlayTarget;
}) {
  const { addons, loading } = useStreamAddons(profile.id);
  const sources = useStreams(addons, type, video);
  const names = new Map(addons.map((addon) => [addon.url, addon.manifest.name]));

  // What ranking knows: the title's details, as its page asked for them
  // (usually cached by now), and the profile's audio language. It starts
  // without them and starts again once they come.
  const client = useQueryClient();
  const browsing = useLoadedAddons(profile.id);
  const details = useQuery({
    ...titleMetaQuery(browsing.addons, type, target.id),
    enabled: !browsing.loading,
    ...cachedTitleMeta(client, browsing.addons, type, target.id),
  });
  const settings = useQuery(profileSettingsQuery(profile.id));
  const ctx = titleContext(type, video, details.data?.meta, target.title);
  const prefs = rankingPrefs(settings.data);
  const { view, pin } = useRankedStreams(sources, ctx, prefs);
  const [showCollapsed, setShowCollapsed] = useState(false);

  if (sources.length === 0) {
    if (loading) return <Asking />;
    return (
      <div className="pt-12">
        <Notice
          icon={Puzzle}
          title="No addon has streams for this"
          description="None of your enabled addons serves streams for it. Add a stream addon to watch it."
          action={
            <Link to="/addons" className={buttonVariants()}>
              Manage addons
            </Link>
          }
        />
      </div>
    );
  }

  const waiting = sources.filter((source) => source.status === "pending").length;
  return (
    <>
      <div className="flex flex-col gap-3 px-gutter">
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {view.total === 1 ? "1 stream" : `${view.total} streams`}
          {waiting > 0
            ? `, ${waiting} of ${sources.length} addons still answering`
            : // An addon whose manifest is still loading may serve streams too.
              loading
              ? ", still loading addons"
              : ` from ${sources.length === 1 ? "1 addon" : `${sources.length} addons`}`}
        </p>
        <ul aria-label="Addons" className="flex flex-wrap gap-2">
          {sources.map((source) => (
            <SourceStatus key={source.addon.url} source={source} />
          ))}
        </ul>
      </div>
      <StreamList
        rows={rows(view, showCollapsed)}
        names={names}
        onNavigate={pin}
        onPick={() =>
          toastManager.add({
            title: `Can’t play ${target.title} yet`,
            description: "Sinag’s player isn’t built yet.",
          })
        }
      />
      <CollapsedToggle view={view} shown={showCollapsed} onToggle={setShowCollapsed} />
    </>
  );
}

function SourceStatus({ source }: { source: StreamSource }) {
  const { name } = source.addon.manifest;
  const count = source.streams?.length ?? 0;
  return (
    <li
      aria-label={name}
      className="flex h-9 items-center gap-2 rounded-full border bg-card ps-3 pe-1.5 text-sm"
    >
      {source.status === "pending" && <Spinner className="size-4 text-muted-foreground" />}
      {source.status === "success" && <Check aria-hidden className="size-4 text-brand" />}
      {source.status === "error" && (
        <AlertCircle aria-hidden className="size-4 text-destructive-foreground" />
      )}
      <span className="font-medium">{name}</span>
      <span className="pe-1.5 text-muted-foreground">
        {source.status === "pending"
          ? "Asking…"
          : source.status === "success"
            ? count === 1
              ? "1 stream"
              : `${count} streams`
            : source.error?.message}
      </span>
      {source.status === "error" && (
        <Button size="sm" variant="ghost" className="rounded-full" onClick={source.retry}>
          Try again
        </Button>
      )}
    </li>
  );
}

// A listed stream: the top pick, then the rest by rank, then (when shown)
// the collapsed groups.
type Row = { candidate: Candidate; tier: Tier; top: boolean };

function rows(view: RankedView, showCollapsed: boolean): Row[] {
  const out: Row[] = view.top ? [{ candidate: view.top, tier: view.top.tier, top: true }] : [];
  for (const { tier, items } of view.groups) {
    if (collapsedTiers.has(tier) && !showCollapsed) continue;
    for (const candidate of items) {
      if (candidate !== view.top) out.push({ candidate, tier, top: false });
    }
  }
  return out;
}

function CollapsedToggle({
  view,
  shown,
  onToggle,
}: {
  view: RankedView;
  shown: boolean;
  onToggle: (shown: boolean) => void;
}) {
  const counts = view.groups.filter(({ tier }) => collapsedTiers.has(tier));
  if (counts.length === 0) return null;
  const label = counts
    .map(
      ({ tier, items }) => `${items.length} ${tier === "Low quality" ? "CAM / TS" : "likely fake"}`,
    )
    .join(" and ");
  return (
    <div className="px-gutter">
      <Button variant="ghost" onClick={() => onToggle(!shown)}>
        {shown ? `Hide ${label}` : `Show ${label}`}
      </Button>
    </div>
  );
}

// A row's height before it's measured: two lines of name and two of detail.
const rowPx = 88;

// The streams, scrolled with the page and virtualized: one addon can send
// over a thousand. Moving into the list pins the top pick.
function StreamList({
  rows: items,
  names,
  onNavigate,
  onPick,
}: {
  rows: readonly Row[];
  names: ReadonlyMap<string, string>;
  onNavigate: () => void;
  onPick: () => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [top, setTop] = useState(0);

  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return undefined;
    const parent = scrollParent(element);
    setScroller(parent);
    const update = () =>
      setTop(
        element.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop,
      );
    update();
    // jsdom has no ResizeObserver.
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    if (parent.firstElementChild) observer.observe(parent.firstElementChild);
    return () => observer.disconnect();
  }, []);

  // No React Compiler in this app: nothing here is memoized behind its back.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller,
    estimateSize: () => rowPx,
    // Nothing laid out (jsdom, a hidden page): keep the estimate.
    measureElement: (element) => element.getBoundingClientRect().height || rowPx,
    getItemKey: (index) => items[index]!.candidate.key,
    scrollMargin: top,
    overscan: 6,
    initialRect: { width: 0, height: window.innerHeight },
  });

  return (
    <ol
      ref={list}
      aria-label="Streams"
      className="relative px-gutter"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const { candidate, tier, top: best } = items[item.index]!;
        const { stream } = candidate;
        const addon = names.get(candidate.source) ?? "";
        const name = lines(stream.name).join(" · ");
        // Torrentio's names start with its own.
        const from = name.startsWith(addon) ? undefined : addon;
        return (
          <li
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            className="absolute inset-x-gutter top-0 py-1"
            style={{ transform: `translateY(${item.start - top}px)` }}
          >
            <button
              type="button"
              onClick={onPick}
              onFocus={onNavigate}
              onPointerDown={onNavigate}
              className="flex w-full cursor-pointer flex-col gap-1 rounded-lg px-3 py-2 text-start outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex gap-2 text-sm">
                <span className="font-medium text-brand">{best ? "Top pick" : tier}</span>
                <span className="font-medium">{name || addon}</span>
                {name && from && <span className="text-muted-foreground">{from}</span>}
              </span>
              {stream.description && (
                <span className="line-clamp-2 font-mono text-meta whitespace-pre-line text-muted-foreground">
                  {stream.description}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

const lines = (text: string | undefined) =>
  (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
