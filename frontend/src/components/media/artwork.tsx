import { useState, type CSSProperties } from "react";

import { cn } from "@/lib/utils";

// A stable hue per title, so a title without artwork always gets the same
// colours.
function hueOf(title: string): number {
  let hash = 0;
  for (const char of title) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return hash;
}

export function placeholderStyle(title: string): CSSProperties {
  const hue = hueOf(title);
  return {
    backgroundImage: [
      `radial-gradient(120% 80% at 20% 0%, oklch(0.62 0.13 ${hue} / 0.9), transparent 60%)`,
      `radial-gradient(90% 70% at 100% 100%, oklch(0.45 0.12 ${(hue + 50) % 360} / 0.9), transparent 70%)`,
      `linear-gradient(160deg, oklch(0.32 0.08 ${hue}), oklch(0.16 0.04 ${(hue + 30) % 360}))`,
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
// `src` (addons often lack art), it shows a generated gradient and, for
// cards, the title set in the display face.
export function Artwork({
  src,
  title,
  showTitle = false,
  titleClassName,
  className,
}: {
  src?: string | undefined;
  title: string;
  showTitle?: boolean;
  titleClassName?: string | undefined;
  className?: string;
}) {
  // What this <img> did; until it does anything, what the URL did before.
  const [own, setOwn] = useState<{ src: string; status: "loaded" | "failed" }>();
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
            "absolute inset-x-0 bottom-0 line-clamp-3 p-3 font-heading text-lg leading-tight font-bold text-balance text-white font-stretch-semi-expanded",
            titleClassName,
          )}
        >
          {title}
        </span>
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
              "transition-opacity duration-(--duration-slow) ease-smooth",
          )}
        />
      )}
    </div>
  );
}
