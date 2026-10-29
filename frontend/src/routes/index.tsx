import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";

import { NoAddons } from "@/components/addons/no-addons";
import { LandscapeCard, PosterCard } from "@/components/media/cards";
import { Row, RowGroup, RowSkeleton } from "@/components/media/row";
import { buttonVariants } from "@/components/ui/button";
import { visibleAddonsQuery } from "@/lib/addons";
import { collectionsQuery, homeLayoutQuery, homeSections, type HomeSection } from "@/lib/home";
import {
  continueWatchingItems,
  continueWatchingQuery,
  episodeLabel,
  libraryQuery,
  watchedFraction,
} from "@/lib/library";
import { currentProfileQuery } from "@/lib/profile";
import type { Profile } from "@bindings/store";

export const Route = createFileRoute("/")({
  component: Home,
});

// Continue Watching, the collections and the library, from the local store,
// so Home opens with them offline (#31). Rows follow the layout made in
// Nuvio's apps (#35). The hero and the catalog rows are #42's. With no addon
// to browse, it says how to add one first (#39), so a fresh install never
// opens on an empty page.
function Home() {
  const profile = useQuery(currentProfileQuery).data;
  return (
    <>
      <h1 className="sr-only">Home</h1>
      {profile ? <HomeRows profile={profile} /> : <HomeSkeleton />}
    </>
  );
}

function HomeRows({ profile }: { profile: Profile }) {
  const profileId = profile.id;
  const visible = useQuery(visibleAddonsQuery(profileId));
  const library = useQuery(libraryQuery(profileId));
  const watching = useQuery(continueWatchingQuery(profileId));
  const layout = useQuery(homeLayoutQuery(profileId));
  const collections = useQuery(collectionsQuery(profileId));

  const noAddons = visible.data?.length === 0 && <NoAddons profile={profile} />;
  if (!library.data || !watching.data) {
    return library.isError || watching.isError ? noAddons || null : <HomeSkeleton />;
  }
  // Catalog rows wait for the addon client (#37, #42).
  const sections = homeSections(layout.data, collections.data ?? []).filter(
    (section) => section.kind === "collection",
  );
  if (library.data.length === 0 && watching.data.length === 0 && sections.length === 0) {
    return (
      noAddons || (
        <p className="p-8 text-center text-sm text-muted-foreground">
          Titles you save and watch show up here.
        </p>
      )
    );
  }

  const items = continueWatchingItems(watching.data, library.data);
  return (
    <div className="flex flex-col gap-6 py-6">
      {noAddons}
      <RowGroup>
        {items.length > 0 && (
          <Row
            title="Continue watching"
            card="landscape"
            items={items}
            getKey={({ entry }) => entry.key}
            renderItem={({ entry, title, art }) => (
              <LandscapeCard
                title={title}
                meta={episodeLabel(entry)}
                src={art}
                progress={watchedFraction(entry)}
              />
            )}
          />
        )}
        {sections.map((section) => (
          <SectionRow key={section.key} section={section} />
        ))}
        {library.data.length > 0 && (
          <Row
            title="Your library"
            action={
              <Link to="/library" className={buttonVariants({ variant: "link", size: "sm" })}>
                See all
              </Link>
            }
            items={library.data}
            getKey={(item) => `${item.contentId}:${item.contentType}`}
            renderItem={(item) => (
              <PosterCard title={item.name} meta={item.releaseInfo} src={item.poster} />
            )}
          />
        )}
      </RowGroup>
    </div>
  );
}

// A collection's folders, as tiles. Opening one is the browse page's (#43).
function SectionRow({ section }: { section: HomeSection }) {
  if (section.kind !== "collection") return null;
  const { collection } = section;
  const folders = collection.folders ?? [];
  if (folders.length === 0) return null;
  return (
    <Row
      title={collection.title}
      items={folders}
      getKey={(folder) => folder.id}
      card={(folder) => (folder.shape === "POSTER" ? "poster" : "landscape")}
      renderItem={(folder) => {
        const Card = folder.shape === "POSTER" ? PosterCard : LandscapeCard;
        return (
          <Card
            title={folder.emoji ? `${folder.emoji} ${folder.title}` : folder.title}
            src={folder.cover || folder.backdrop}
          />
        );
      }}
    />
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
