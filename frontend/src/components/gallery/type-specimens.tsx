import { useState, type CSSProperties, type ReactNode } from "react";

import { GallerySection } from "@/components/gallery/gallery-section";
import { Artwork } from "@/components/media/artwork";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";

// One heading style: Mona Sans's width axis (font-stretch, %), weight,
// tracking (em) and, where it differs from the shared default, size.
type HeadingStyle = {
  stretch: number;
  weight: number;
  tracking: number;
  size?: string;
  lineHeight?: number;
};

// The three type options of #112. Every value is the ticket's; the body, caption and
// label rows below are shared except for the eyebrow face.
export type TypeOption = {
  id: "A" | "B" | "C";
  name: string;
  summary: string;
  display: HeadingStyle;
  pageTitle: HeadingStyle;
  rowHeading: HeadingStyle;
  // Eyebrows and labels: Mona Sans (A, B) or Geist Mono (C, today's look).
  eyebrow: "sans" | "mono";
};

const pageTitle: HeadingStyle = {
  stretch: 100,
  weight: 700,
  tracking: -0.025,
  size: "2.25rem",
  lineHeight: 1.1,
};

const rowHeading = (weight: number): HeadingStyle => ({
  stretch: 100,
  weight,
  tracking: -0.015,
  size: "1.375rem",
  lineHeight: 1.2,
});

export const typeOptions: readonly TypeOption[] = [
  {
    id: "A",
    name: "Calm",
    summary: "Normal width everywhere; weight and tight tracking carry the hierarchy.",
    display: { stretch: 100, weight: 720, tracking: -0.035, lineHeight: 0.95 },
    pageTitle,
    rowHeading: rowHeading(650),
    eyebrow: "sans",
  },
  {
    id: "B",
    name: "Semi-wide",
    summary: "Hero and page titles at 112.5% width, row headings at normal width. Recommended.",
    display: { stretch: 112.5, weight: 700, tracking: -0.03, lineHeight: 0.95 },
    pageTitle: { stretch: 112.5, weight: 660, tracking: -0.02, size: "2.25rem", lineHeight: 1.1 },
    rowHeading: rowHeading(640),
    eyebrow: "sans",
  },
  {
    id: "C",
    name: "Marquee",
    summary: "A 125% wide, heavy hero; everything else calm. Eyebrows stay mono.",
    display: { stretch: 125, weight: 820, tracking: -0.03, lineHeight: 0.95 },
    pageTitle,
    rowHeading: rowHeading(650),
    eyebrow: "mono",
  },
];

// Shared by all three: body 15px / 450, card captions 15px / 550 with 13px
// meta, 12px labels.
const body = { fontSize: "0.9375rem", fontWeight: 450, lineHeight: 1.45 } as const;
const caption = { fontSize: "0.9375rem", fontWeight: 550, lineHeight: 1.3 } as const;
const captionMeta = { fontSize: "0.8125rem", lineHeight: 1.4 } as const;

function heading(style: HeadingStyle): CSSProperties {
  return {
    fontFamily: "var(--font-heading)",
    fontStretch: `${style.stretch}%`,
    fontWeight: style.weight,
    letterSpacing: `${style.tracking}em`,
    ...(style.size ? { fontSize: style.size } : { fontSize: "var(--text-display)" }),
    lineHeight: style.lineHeight ?? 1.1,
  };
}

// A label such as "Director" or "Continue watching": 12px, uppercase.
function label(option: TypeOption): CSSProperties {
  return option.eyebrow === "mono"
    ? {
        fontFamily: "var(--font-mono)",
        fontSize: "0.75rem",
        fontWeight: 500,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
      }
    : {
        fontFamily: "var(--font-sans)",
        fontSize: "0.75rem",
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
      };
}

// Numbers and codes: years, runtimes, S2 · E5, times, sizes, versions.
function Num({ children }: { children: ReactNode }) {
  return <span className="font-mono tabular-nums">{children}</span>;
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
      <h3 className="font-mono text-meta text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

// The sample the switch applies an option to. Every style comes from the option's
// own values, set inline, so the page's current type tokens don't leak in.
export function TypeSample({ option }: { option: TypeOption }) {
  return (
    <div className="flex flex-col gap-8" style={{ ...body }} data-type-option={option.id}>
      <Block title="Home hero · display, meta line, synopsis">
        <div
          className="dark flex min-h-72 items-end overflow-hidden rounded-2xl p-8 text-foreground"
          style={heroBackdrop}
        >
          <div className="flex max-w-xl flex-col gap-3">
            <p className="text-brand" style={label(option)}>
              New season
            </p>
            <h4 className="text-balance" style={heading(option.display)}>
              Northern Current
            </h4>
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
          <h4 style={heading(option.rowHeading)}>Continue watching</h4>
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
                  <span className="truncate" style={caption}>
                    {title}
                  </span>
                  <span className="truncate text-muted-foreground" style={captionMeta}>
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
          <h4 style={heading(option.pageTitle)}>Saltwater Hymns</h4>
          <dl className="grid max-w-md grid-cols-[auto_1fr] gap-x-6 gap-y-2">
            {(
              [
                { term: "Director", value: <span>Ines Marlow</span> },
                { term: "Runtime", value: <Num>1h 41m</Num> },
                { term: "Released", value: <Num>12 Mar 2023</Num> },
              ] as const
            ).map(({ term, value }) => (
              <div key={term} className="contents">
                {" "}
                <dt className="text-muted-foreground" style={label(option)}>
                  {term}
                </dt>
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
              <span style={caption}>Skip intros</span>
              <span className="text-muted-foreground" style={captionMeta}>
                Jump past the opening credits when a marker exists.
              </span>
            </div>
            <Switch defaultChecked aria-label="Skip intros" />
          </div>
        </Block>

        <Block title="Player time readout">
          <div className="dark flex items-center gap-4 rounded-xl bg-black/80 px-4 py-3 text-foreground">
            <span className="font-mono tabular-nums" style={{ fontSize: "0.8125rem" }}>
              1:12:08
            </span>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/25">
              <div className="h-full w-2/5 rounded-full bg-brand" />
            </div>
            <span
              className="font-mono text-white/70 tabular-nums"
              style={{ fontSize: "0.8125rem" }}
            >
              −0:29:33
            </span>
          </div>
        </Block>
      </div>
    </div>
  );
}

// The ticket's table, as read-out under the switch.
function Values({ option }: { option: TypeOption }) {
  const rows = [
    ["Display", option.display],
    ["Page title", option.pageTitle],
    ["Row heading", option.rowHeading],
  ] as const;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 font-mono text-meta text-muted-foreground">
      {rows.map(([name, style]) => (
        <div key={name} className="contents">
          <dt>{name}</dt>
          <dd>
            {style.stretch}% width · weight {style.weight} · {style.tracking}em
            {style.size ? ` · ${style.size}` : " · clamp 2.5–4.5rem"}
          </dd>
        </div>
      ))}
      <div className="contents">
        <dt>Body / UI</dt>
        <dd>15px · 450 · 0 · line-height 1.45</dd>
      </div>
      <div className="contents">
        <dt>Card caption</dt>
        <dd>15px · 550 · meta 13px</dd>
      </div>
      <div className="contents">
        <dt>Eyebrows / labels</dt>
        <dd>
          {option.eyebrow === "mono"
            ? "Geist Mono 12px · uppercase"
            : "Mona Sans 12px · 600 · +0.06em · uppercase"}
        </dd>
      </div>
    </dl>
  );
}

export function TypeSpecimens() {
  const [id, setId] = useState<TypeOption["id"]>("B");
  const [all, setAll] = useState(false);
  const shown = all ? typeOptions : typeOptions.filter((option) => option.id === id);
  return (
    <GallerySection
      title="Type specimens"
      description="Three ways to set Mona Sans and Geist Mono (#112). The families stay; widths, weights, tracking and where mono appears change. Pick one with the switch, or show all three."
    >
      <div className="flex flex-wrap items-center gap-4">
        <ToggleGroup
          aria-label="Type option"
          value={[id]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "A" || next === "B" || next === "C") setId(next);
          }}
        >
          {typeOptions.map((option) => (
            <Toggle key={option.id} value={option.id} aria-label={`Option ${option.id}`}>
              {option.id} · {option.name}
            </Toggle>
          ))}
        </ToggleGroup>
        <div className="flex items-center gap-2 text-sm">
          <Switch checked={all} onCheckedChange={setAll} aria-label="Show all three" />
          <span aria-hidden>Show all three</span>
        </div>
      </div>
      <div className={cn("grid gap-10", all && "xl:grid-cols-3")}>
        {shown.map((option) => (
          <section key={option.id} className="flex min-w-0 flex-col gap-6">
            <header className="flex flex-col gap-2">
              <h3 className="font-heading text-heading font-stretch-semi-expanded">
                {option.id} · {option.name}
              </h3>
              <p className="text-pretty text-muted-foreground">{option.summary}</p>
              <Values option={option} />
            </header>
            <TypeSample option={option} />
          </section>
        ))}
      </div>
    </GallerySection>
  );
}
