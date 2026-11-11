import { useState, type CSSProperties } from "react";

import { sharper, type ArtworkUse } from "@/lib/artwork-url";
import { cn } from "@/lib/utils";

// A stable hue per title, so a title without artwork always gets the same
// colours.
function hueOf(title: string): number {
  let hash = 0;
  for (const char of title) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return hash;
}

// Missing art becomes a dimly lit slate in the title's own hue: a low warm
// light from above, deepening towards the bottom, like a dark stage.
export function placeholderStyle(title: string): CSSProperties {
  const hue = hueOf(title);
  return {
    backgroundColor: `oklch(0.22 0.025 ${hue})`,
    backgroundImage: [
      `radial-gradient(90% 60% at 50% -10%, oklch(0.52 0.09 ${hue} / 0.75), transparent 70%)`,
      `linear-gradient(to bottom, transparent 40%, oklch(0.13 0.02 ${hue}))`,
    ].join(", "),
  };
}

// What each image URL did this session. Virtualized rows unmount cards that
// scroll away and mount fresh <img>s when they come back: a URL known to
// load (WebKit's cache has the bytes) shows at once rather than fading in
// from the placeholder again, and a known-broken one isn't fetched again.
const seen = new Map<string, "loaded" | "failed">();
const seenLimit = 2000;

function remember(src: string, status: "loaded" | "failed") {
  seen.delete(src);
  seen.set(src, status);
  if (seen.size > seenLimit) seen.delete(seen.keys().next().value!);
}

// For tests.
export function forgetArtwork() {
  seen.clear();
}

// A poster, still or backdrop. Fades in once loaded; until then, or with no
// `src` (addons often lack art), it shows a slate in the title's hue and,
// for cards, the title set in the display serif. A `fallback` image shows under
// it while it loads and if it fails: the art it replaces, such as the
// addon's backdrop under TMDB's (#47), so swapping art never flashes the
// gradient.
//
// With a `use`, the URL is first rewritten to a sharper size (#113,
// `lib/artwork-url.ts`) here, in the one place every card, still, cover and
// hero goes through. The `seen` map is keyed by the rewritten URL, so the
// cache stays coherent; if that URL fails, the original is tried once.
export function Artwork({
  src: original,
  use,
  fallback,
  title,
  showTitle = false,
  titleClassName,
  className,
}: {
  src?: string | undefined;
  use?: ArtworkUse | undefined;
  fallback?: string | undefined;
  title: string;
  showTitle?: boolean;
  titleClassName?: string | undefined;
  className?: string;
}) {
  // What this <img> did; until it does anything, what the URL did before.
  const [own, setOwn] = useState<{ src: string; status: "loaded" | "failed" }>();
  const sharp = use ? sharper(original, use) : original;
  const sharpFailed =
    sharp !== original &&
    (own && own.src === sharp ? own.status === "failed" : seen.get(sharp ?? "") === "failed");
  // The sharper URL, or the original once it has failed.
  const src = sharpFailed ? original : sharp;
  const known = src ? seen.get(src) : undefined;
  const status = own && own.src === src ? own.status : known;
  const settle = (next: "loaded" | "failed") => {
    if (!src) return;
    remember(src, next);
    setOwn({ src, status: next });
  };

  return (
    <div
      className={cn("relative size-full overflow-hidden bg-muted", className)}
      // Under the art too, while a cached image decodes.
      style={placeholderStyle(title)}
      data-slot="artwork"
    >
      {status !== "loaded" && showTitle && (
        <span
          aria-hidden
          className={cn(
            "absolute inset-0 flex items-center justify-center p-4 text-center font-display text-[1.375rem] leading-[1.05] text-balance text-white/90",
            titleClassName,
          )}
        >
          {title}
        </span>
      )}
      {fallback && fallback !== src && status !== "loaded" && seen.get(fallback) !== "failed" && (
        <img
          src={fallback}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={() => remember(fallback, "loaded")}
          onError={() => remember(fallback, "failed")}
          className="absolute inset-0 size-full object-cover"
        />
      )}
      {src && status !== "failed" && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => settle("loaded")}
          onError={() => settle("failed")}
          className={cn(
            "absolute inset-0 size-full object-cover",
            status !== "loaded" && "opacity-0",
            // A cached image shows at once; only a first load fades.
            (status !== "loaded" || own?.src === src) &&
              "transition-opacity duration-(--duration-slow) ease-out-soft",
          )}
        />
      )}
    </div>
  );
}
