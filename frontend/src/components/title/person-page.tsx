import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { KeyRound, UserRound } from "lucide-react";
import { useState } from "react";

import { Notice } from "@/components/browse/browse-page";
import { Ambient } from "@/components/media/ambient";
import { Artwork } from "@/components/media/artwork";
import { PosterCard } from "@/components/media/cards";
import { Chip, ChipGroup } from "@/components/media/chip";
import { PosterGrid } from "@/components/media/poster-grid";
import { BackButton } from "@/components/title/back-button";
import { useOpenRelated } from "@/components/title/related-rows";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { currentProfileQuery } from "@/lib/profile";
import {
  sortCredits,
  useTmdbPerson,
  type CreditGroup,
  type CreditSort,
  type TmdbPerson,
} from "@/lib/tmdb-person";

// A person's page (TMDB id): photo, name, what they're known for, a short
// biography, and their films and series by kind of work. Everything comes
// from TMDB, so without a key the page says how to add one. Titles open in
// Sinag through the IMDb id looked up on click, as More Like This does.
export function PersonPage() {
  const { id } = useParams({ from: "/person/$id" });
  const tmdb = /^\d+$/.test(id) ? Number(id) : 0;
  const profile = useQuery(currentProfileQuery).data;
  const { key, person, isError, refetch } = useTmdbPerson(tmdb);

  return (
    <div className="relative flex flex-col gap-12 pt-6 pb-20">
      <BackButton hero={null} />
      {key === false ? (
        <NoKey />
      ) : person ? (
        <>
          <Header person={person} />
          {profile &&
            (profile.kids ? (
              // Kids rules are about addons, and TMDB's credits can't be
              // checked against them, so nothing is listed (fail closed). The
              // same while the profile is still loading.
              <p className="px-page text-muted-foreground">
                Films and series aren’t shown on a kids profile.
              </p>
            ) : (
              <Filmography groups={person.groups} />
            ))}
        </>
      ) : person === null || tmdb === 0 ? (
        <Missing />
      ) : isError ? (
        <div className="pt-16">
          <Notice
            icon={UserRound}
            title="Couldn’t load this person"
            description="TMDB didn’t answer. It may be down, or you may be offline."
            action={<Button onClick={refetch}>Try again</Button>}
          />
        </div>
      ) : (
        <HeaderSkeleton />
      )}
    </div>
  );
}

function NoKey() {
  return (
    <div className="pt-16">
      <Notice
        icon={KeyRound}
        title="People come from TMDB"
        description="Add your own TMDB key to see biographies and filmographies. It’s free and optional."
        action={
          <Link to="/settings" search={{ section: "content" }} className={buttonVariants()}>
            Open settings
          </Link>
        }
      />
    </div>
  );
}

function Missing() {
  return (
    <div className="pt-16">
      <Notice
        icon={UserRound}
        title="TMDB doesn’t know this person"
        description="There’s nothing to show for them."
      />
    </div>
  );
}

function HeaderSkeleton() {
  return (
    <div className="flex items-end gap-8 px-page pt-10" aria-hidden>
      <Skeleton className="size-52 shrink-0 rounded-full" />
      <div className="flex flex-col gap-3 pb-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-14 w-80" />
      </div>
    </div>
  );
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const formatDay = (day: string) => {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : dateFormat.format(date);
};

// "Born 12 May 1956 in Boston, USA" / "12 May 1956 – 3 Jan 2020".
function facts(person: TmdbPerson): string[] {
  const out: string[] = [];
  if (person.born) {
    out.push(
      `Born ${formatDay(person.born)}${person.birthplace ? ` in ${person.birthplace}` : ""}`,
    );
  } else if (person.birthplace) {
    out.push(`Born in ${person.birthplace}`);
  }
  if (person.died) out.push(`Died ${formatDay(person.died)}`);
  return out;
}

// The photo at w-52 beside the name, over the photo's own colours (as a
// folder's cover is).
function Header({ person }: { person: TmdbPerson }) {
  const [more, setMore] = useState(false);
  const lines = facts(person);
  return (
    <section
      aria-label={person.name}
      className="relative isolate flex flex-col gap-8 px-page pt-10 sm:flex-row sm:items-end"
    >
      <Ambient src={person.photo} className="top-[calc(-1*(var(--spacing-bar)+1.5rem))]" />
      <div className="aspect-[2/3] w-52 shrink-0 overflow-hidden rounded-xl shadow-float">
        <Artwork src={person.photo} use="avatar" title={person.name} />
      </div>
      <div className="flex min-w-0 max-w-prose flex-col gap-3 pb-2">
        {person.department && <p className="type-eyebrow text-sun-ink">{person.department}</p>}
        <h1 className="type-display text-balance">{person.name}</h1>
        {lines.length > 0 && (
          <ul className="flex flex-col text-small text-muted-foreground tnum">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {person.biography && (
          <div className="flex flex-col items-start gap-1">
            <p
              className={`text-[0.9375rem] leading-relaxed text-pretty whitespace-pre-line text-foreground/80 ${more ? "" : "line-clamp-5"}`}
            >
              {person.biography}
            </p>
            {person.biography.length > 320 && (
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={more}
                onClick={() => setMore((value) => !value)}
              >
                {more ? "Show less" : "Read more"}
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// Each kind of work in its own grid, under one sort for all of them.
function Filmography({ groups }: { groups: CreditGroup[] }) {
  const [sort, setSort] = useState<CreditSort>("popular");
  const open = useOpenRelated();
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-col gap-10">
      <ChipGroup
        aria-label="Sort"
        className="px-page"
        value={[sort]}
        onValueChange={(value: string[]) => {
          const [next] = value;
          if (next === "popular" || next === "newest") setSort(next);
        }}
      >
        <Chip value="popular">Popular</Chip>
        <Chip value="newest">Newest</Chip>
      </ChipGroup>
      {groups.map((group) => (
        <section
          key={group.label}
          aria-labelledby={`credits-${group.label}`}
          className="flex flex-col gap-4"
        >
          <h2
            id={`credits-${group.label}`}
            className="px-page font-display text-[2.25rem] leading-none"
          >
            {group.label}
          </h2>
          <PosterGrid
            label={group.label}
            items={sortCredits(group.credits, sort)}
            getKey={(credit) => `${credit.media}:${credit.tmdb}`}
            renderItem={(credit) => (
              <PosterCard
                title={credit.title}
                meta={[credit.year, credit.role].filter(Boolean).join(" · ")}
                src={credit.poster}
                onClick={() => void open(credit)}
              />
            )}
          />
        </section>
      ))}
    </div>
  );
}
