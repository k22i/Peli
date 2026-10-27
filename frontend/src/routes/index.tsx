import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";

import { LandscapeCard, PosterCard } from "@/components/media/cards";
import { Row, RowSkeleton } from "@/components/media/row";
import { buttonVariants } from "@/components/ui/button";
import {
  continueWatchingItems,
  continueWatchingQuery,
  episodeLabel,
  libraryQuery,
  watchedFraction,
} from "@/lib/library";
import { useCurrentProfile } from "@/lib/profile";

export const Route = createFileRoute("/")({
  component: Home,
});

// Continue Watching and the library, from the local store, so Home opens
// with them offline (#31). The hero and the catalog rows are #42's.
function Home() {
  const { id } = useCurrentProfile();
  return (
    <>
      <h1 className="sr-only">Home</h1>
      {id === undefined ? <HomeSkeleton /> : <HomeRows profileId={id} />}
    </>
  );
}

function HomeRows({ profileId }: { profileId: number }) {
  const library = useQuery(libraryQuery(profileId));
  const watching = useQuery(continueWatchingQuery(profileId));

  if (!library.data || !watching.data) {
    return library.isError || watching.isError ? null : <HomeSkeleton />;
  }
  if (library.data.length === 0 && watching.data.length === 0) {
    return (
      <p className="p-8 text-center text-sm text-muted-foreground">
        Titles you save and watch show up here.
      </p>
    );
  }

  const items = continueWatchingItems(watching.data, library.data);
  return (
    <div className="flex flex-col gap-6 py-6">
      {items.length > 0 && (
        <Row title="Continue watching">
          {items.map(({ entry, title, art }) => (
            <LandscapeCard
              key={entry.key}
              title={title}
              meta={episodeLabel(entry)}
              src={art}
              progress={watchedFraction(entry)}
            />
          ))}
        </Row>
      )}
      {library.data.length > 0 && (
        <Row
          title="Your library"
          action={
            <Link to="/library" className={buttonVariants({ variant: "link", size: "sm" })}>
              See all
            </Link>
          }
        >
          {library.data.map((item) => (
            <PosterCard
              key={`${item.contentId}:${item.contentType}`}
              title={item.name}
              meta={item.releaseInfo}
              src={item.poster}
            />
          ))}
        </Row>
      )}
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-6 py-6">
      <RowSkeleton card="landscape" />
      <RowSkeleton />
    </div>
  );
}
