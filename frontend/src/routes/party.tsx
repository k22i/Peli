import { createFileRoute } from "@tanstack/react-router";
import { Play, Users } from "lucide-react";

import { Artwork } from "@/components/media/artwork";
import { PartyChat } from "@/components/party/party-chat";
import { JoinParty, PartyPanel } from "@/components/party/party-panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { mediaLabel, partyProblem, useParty, useWatchWithParty, type PartyInfo } from "@/lib/party";

// Reached from the profile menu, the palette and the party pill in the top
// bar.
export const Route = createFileRoute("/party")({
  component: PartyPage,
});

// The watch party page (ADR-0051): join one with a friend's code, or, in
// one, what it watches (to watch it with them), its people and the chat.
// Hosting starts from the player, with what's playing.
function PartyPage() {
  const state = useParty();
  const party = state?.party ?? undefined;
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-page pt-8 pb-16">
      <h1 className="font-display text-[clamp(2.75rem,1.9rem+2.6vw,4.5rem)] leading-[0.95] tracking-[-0.01em]">
        Watch party
      </h1>
      {!state ? (
        <Skeleton className="h-60 rounded-2xl" />
      ) : party ? (
        <InParty party={party} />
      ) : state.unavailable ? (
        <div className="flex max-w-md flex-col items-start gap-3 rounded-2xl bg-foreground/5 p-6">
          <Users aria-hidden className="size-6 text-muted-foreground" />
          <p className="text-body">{partyProblem(state.unavailable)}</p>
        </div>
      ) : (
        <div className="grid gap-10 md:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <section aria-label="Join a watch party" className="flex flex-col gap-4">
            <h2 className="type-title">Join a watch party</h2>
            <JoinParty />
          </section>
          <section
            aria-label="Host one"
            className="flex flex-col gap-3 text-body text-muted-foreground"
          >
            <h2 className="type-title text-foreground">Host one</h2>
            <p>
              Start playing something, then choose Watch party (or press W) in the player. You’ll
              get a code to share with friends on Peli, or on Nuvio’s phone, TV and desktop apps.
            </p>
            <p>
              Everyone plays from their own addons and stays in step: when anyone pauses, skips or
              is still loading, the party waits for them.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

function InParty({ party }: { party: PartyInfo }) {
  const watchWithParty = useWatchWithParty();
  const media = party.media;
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <div className="flex flex-col gap-8">
        <section
          aria-label="Watching now"
          className="relative isolate flex min-h-56 items-end overflow-hidden rounded-3xl bg-foreground/6 p-6"
        >
          {(media.background || media.poster) && (
            <>
              <Artwork
                src={media.background || media.poster}
                use="backdrop"
                title={media.title}
                className="absolute inset-0 -z-10"
              />
              <div className="absolute inset-0 -z-10 bg-linear-to-t from-black/85 via-black/40 to-black/10" />
            </>
          )}
          <div
            className={
              media.background || media.poster
                ? "dark flex flex-col gap-3 text-foreground"
                : "flex flex-col gap-3"
            }
          >
            <p className="type-eyebrow text-[#ffc46b]">The party is watching</p>
            <p className="font-display text-[2rem] leading-none">{mediaLabel(media)}</p>
            {media.episodeTitle && (
              <p className="text-body text-foreground/75">{media.episodeTitle}</p>
            )}
            <div className="pt-2">
              <Button variant="light" size="lg" onClick={() => watchWithParty(media)}>
                <Play className="fill-current" />
                Watch with the party
              </Button>
            </div>
          </div>
        </section>
        <PartyPanel party={party} />
      </div>
      <section
        aria-label="Chat"
        className="flex h-[32rem] flex-col rounded-3xl bg-foreground/4 p-4 lg:sticky lg:top-[calc(var(--spacing-bar)+1rem)]"
      >
        <h2 className="px-1 pb-2 type-title">Chat</h2>
        <PartyChat />
      </section>
    </div>
  );
}
