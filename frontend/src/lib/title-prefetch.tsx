import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { preloadArtwork, useArtworkDevice } from "@/components/media/artwork";
import { useLoadedAddons } from "@/lib/home";
import { titleMetaQuery, type TitlePreview } from "@/lib/title";
import { prefetchTmdbArt, tmdbRef, useTmdbKey } from "@/lib/tmdb";

// A title's page, got ready while the pointer rests on its card or the card
// has focus: the addon's details and TMDB's art are asked (the queries the
// page asks, so it finds them in the cache) and the hero's backdrop and
// logo loaded, so opening it paints the page whole instead of a skeleton
// and then a fade. The pointer has to stay a moment (`intentMs`), so
// sweeping across a row or arrowing along it doesn't ask for every title
// passed on the way.

const intentMs = 150;

type Prefetch = (title: TitlePreview) => void;

const TitlePrefetchContext = createContext<{ start: Prefetch; cancel: () => void }>({
  start: () => {},
  cancel: () => {},
});

type Inputs = Parameters<typeof prefetch>[0];

// Always rendered, with or without a profile yet, so the pages under it keep
// their place in the tree when the current profile arrives: wrapping them
// only once it had would mount every page twice.
export function TitlePrefetchProvider({
  profileId,
  children,
}: {
  profileId: number | undefined;
  children: ReactNode;
}) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The latest inputs, for a timer set before they changed; none until
  // there's a profile, and nothing is asked until then.
  const now = useRef<Inputs | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const [value] = useState(() => ({
    start: (title: TitlePreview) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (now.current) prefetch(now.current, title);
      }, intentMs);
    },
    cancel: () => clearTimeout(timer.current),
  }));
  const [keep] = useState(() => (inputs: Inputs | undefined) => {
    now.current = inputs;
  });

  return (
    <TitlePrefetchContext value={value}>
      {profileId !== undefined && <PrefetchInputs profileId={profileId} keep={keep} />}
      {children}
    </TitlePrefetchContext>
  );
}

// The profile's addons, the TMDB key and the device, handed to `keep`.
function PrefetchInputs({
  profileId,
  keep,
}: {
  profileId: number;
  keep: (inputs: Inputs | undefined) => void;
}) {
  const client = useQueryClient();
  const { addons, loading } = useLoadedAddons(profileId);
  const key = useTmdbKey();
  const device = useArtworkDevice();
  useEffect(() => {
    keep({ client, addons, loading, key, device });
  });
  useEffect(() => () => keep(undefined), [keep]);
  return null;
}

function prefetch(
  {
    client,
    addons,
    loading,
    key,
    device,
  }: {
    client: ReturnType<typeof useQueryClient>;
    addons: ReturnType<typeof useLoadedAddons>["addons"];
    loading: boolean;
    key: string | null | undefined;
    device: ReturnType<typeof useArtworkDevice>;
  },
  title: TitlePreview,
) {
  // What the page shows before TMDB answers: the card's own backdrop.
  preloadArtwork(title.background ?? title.poster, "backdrop", device);
  const tmdbArt = (ref: ReturnType<typeof tmdbRef>) => {
    if (!key || !ref) return;
    prefetchTmdbArt(client, key, ref)
      .then((art) => {
        preloadArtwork(art?.backdrop, "backdrop", device);
        preloadArtwork(art?.logo, "logo", device);
      })
      .catch(() => {});
  };
  // An IMDb or TMDB id is looked up at once; a Kitsu id waits for the
  // details' imdb_id, as the page does.
  const direct = tmdbRef(title.type, title.id);
  tmdbArt(direct);
  if (loading) return;
  client
    .fetchQuery(titleMetaQuery(addons, title.type, title.id))
    .then(({ meta }) => {
      if (!direct) tmdbArt(tmdbRef(title.type, title.id, meta));
    })
    .catch(() => {});
}

// Handlers for a card that opens `title`: hover and focus get its page
// ready, leaving or blurring before the moment is up doesn't.
export function usePrefetchTitle(title: TitlePreview | undefined) {
  const { start, cancel } = useContext(TitlePrefetchContext);
  if (!title) return {};
  return {
    onPointerEnter: () => start(title),
    onPointerLeave: cancel,
    onFocus: () => start(title),
    onBlur: cancel,
  };
}
