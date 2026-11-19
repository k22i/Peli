import { createContext, useContext, useState, type CSSProperties } from "react";

import { sharper, viaProxy, type ArtworkDevice, type ArtworkUse } from "@/lib/artwork-url";
import { isIOS } from "@/lib/platform";
import { useCompactShell } from "@/lib/shell-mode";
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
  preloading.clear();
}

// Which sizes Artwork asks for here: iOS asks smaller images (#128); the
// desktop is never compact or iOS.
export function useArtworkDevice(): ArtworkDevice {
  const compact = useCompactShell();
  return compact ? "compact" : isIOS() ? "ios" : "desktop";
}

// Art fetched ahead of the card or page that shows it: the details page a
// card is about to open, say. It's the URL Artwork will ask (the same
// `sharper` rewrite), loaded into WebKit's cache and marked loaded in
// `seen`, so the page's <img> shows at once instead of fading in. The
// Image isn't kept, so nothing stays decoded.
const preloading = new Set<string>();

export function preloadArtwork(
  url: string | undefined,
  use: ArtworkUse | undefined,
  device: ArtworkDevice,
) {
  const src = use ? sharper(url, use, device) : url;
  if (!src || seen.has(src) || preloading.has(src)) return;
  preloading.add(src);
  const image = new Image();
  image.decoding = "async";
  image.addEventListener("load", () => {
    preloading.delete(src);
    remember(src, "loaded");
  });
  // A failure isn't remembered: the card's own <img> tries again, and falls
  // back as it always has.
  image.addEventListener("error", () => preloading.delete(src));
  image.src = viaProxy(src);
}

// Inside a virtualized Row or PosterGrid (#41): only the cards near the
// viewport are mounted, so their art loads at once rather than lazily, and
// the overscanned cards past the edge are ready before they scroll in (a
// lazy <img> in a sideways scroller waits until it's nearly on screen). Not
// on iOS, where every image WebKit loads stays in its memory (#128).
export const EagerArtwork = createContext(false);

// The drop-src retest on iOS WebKit (#128), for the dev rig only: with
// dropSrcKey set, an image's src is taken off as it unmounts. 940e74c took
// that out because it kept removed cards alive on macOS WebKit; the rig's
// "Tab loop, dropping src" row runs the loop with it on, to compare.
export const dropSrcKey = "peli.dev.dropSrc";

function dropSrcTrial(): boolean {
  if (!isIOS()) return false;
  try {
    return window.localStorage.getItem(dropSrcKey) === "1";
  } catch {
    return false;
  }
}

function dropSrcOnUnmount(img: HTMLImageElement | null) {
  if (!img) return undefined;
  return () => img.removeAttribute("src");
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
  const device = useArtworkDevice();
  const eager = useContext(EagerArtwork) && !isIOS();
  const sharp = use ? sharper(original, use, device) : original;
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
          src={viaProxy(fallback)}
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
          ref={dropSrcTrial() ? dropSrcOnUnmount : undefined}
          src={viaProxy(src)}
          alt=""
          loading={eager ? "eager" : "lazy"}
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
