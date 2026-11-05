import type { CSSProperties, ReactNode } from "react";

import { Artwork } from "@/components/media/artwork";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

// The type scale in use (#112, option B · Semi-wide): a hero, a row with two
// captioned posters, a title-page block, a settings row and a player time
// readout, set with the real utilities. No inline font values: if a token
// changes in index.css, this block changes with it.

// Numbers and codes: years, runtimes, S2 · E5, times, sizes, versions.
function Num({ children }: { children: ReactNode }) {
  return <span className="text-num">{children}</span>;
}

const heroBackdrop: CSSProperties = {
  backgroundImage: [
    "radial-gradient(70% 90% at 85% 10%, #33b5e0aa, transparent 60%)",
    "radial-gradient(60% 80% at 100% 100%, #e9573f88, transparent 70%)",
    "linear-gradient(120deg, #07131c, #0f2a3b 60%, #13324a)",
  ].join(", "),
};

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-label text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

export function TypeSample() {
  return (
    <div className="flex flex-col gap-8">
      <Block title="Home hero · display, meta line, synopsis">
        <div
          className="dark flex min-h-72 items-end overflow-hidden rounded-2xl p-8 text-foreground"
          style={heroBackdrop}
        >
          <div className="flex max-w-xl flex-col gap-3">
            <p className="text-label text-brand">New season</p>
            <h4 className="text-display text-balance">Northern Current</h4>
            <p className="flex flex-wrap items-center gap-x-2 text-foreground/80">
              <Num>2025</Num>
              <span aria-hidden>·</span>
              <Num>8 episodes</Num>
              <span aria-hidden>·</span>
              <Num>TV-14</Num>
              <span aria-hidden>·</span>
              <span>Drama</span>
            </p>
            <p className="max-w-lg text-pretty text-foreground/85">
              A marine biologist returns to the fishing town she left at nineteen, where the harbour
              has gone quiet and the tide tables no longer add up.
            </p>
            <div className="mt-1 flex gap-3">
              <Button size="lg">Play</Button>
              <Button size="lg" variant="outline">
                More info
              </Button>
            </div>
          </div>
        </div>
      </Block>

      <Block title="Row heading · card captions under two posters">
        <div className="flex flex-col gap-4">
          <h4 className="text-heading">Continue watching</h4>
          <div className="flex gap-5">
            {[
              ["Low Tide", "2025", "1h 52m"],
              ["Saltwater Hymns", "2023", "S2 · E5"],
            ].map(([title, year, extra]) => (
              <div key={title} className="flex w-40 flex-col gap-2.5">
                <div className="aspect-[2/3] overflow-hidden rounded-xl shadow-card">
                  <Artwork title={title!} showTitle />
                </div>
                <div className="flex flex-col gap-0.5 px-0.5">
                  <span className="truncate text-card">{title}</span>
                  <span className="truncate text-caption text-muted-foreground">
                    <Num>{year}</Num> · <Num>{extra}</Num>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Block>

      <Block title="Title page · page title, labels, synopsis">
        <div className="flex flex-col gap-4">
          <h4 className="text-title">Saltwater Hymns</h4>
          <dl className="grid max-w-md grid-cols-[auto_1fr] gap-x-6 gap-y-2">
            {(
              [
                { term: "Director", value: <span>Ines Marlow</span> },
                { term: "Runtime", value: <Num>1h 41m</Num> },
                { term: "Released", value: <Num>12 Mar 2023</Num> },
              ] as const
            ).map(({ term, value }) => (
              <div key={term} className="contents">
                <dt className="text-label text-muted-foreground">{term}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="max-w-lg text-pretty text-muted-foreground">
            A choir of lighthouse keepers' daughters sails the coast to sing in towns that have
            forgotten their own songs.
          </p>
        </div>
      </Block>

      <div className="grid gap-8 sm:grid-cols-2">
        <Block title="Settings row">
          <div className="flex items-center justify-between gap-6 rounded-xl border bg-card px-4 py-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-card">Skip intros</span>
              <span className="text-caption text-muted-foreground">
                Jump past the opening credits when a marker exists.
              </span>
            </div>
            <Switch defaultChecked aria-label="Skip intros" />
          </div>
        </Block>

        <Block title="Player time readout">
          <div className="dark flex items-center gap-4 rounded-xl bg-black/80 px-4 py-3 text-foreground">
            <span className="text-num text-caption">1:12:08</span>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/25">
              <div className="h-full w-2/5 rounded-full bg-brand" />
            </div>
            <span className="text-num text-caption text-white/70">−0:29:33</span>
          </div>
        </Block>
      </div>
    </div>
  );
}
