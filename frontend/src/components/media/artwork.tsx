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
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const placeholder = !src || failed || !loaded;

  return (
    <div
      className={cn("relative size-full overflow-hidden bg-muted", className)}
      style={placeholder ? placeholderStyle(title) : undefined}
      data-slot="artwork"
    >
      {placeholder && showTitle && (
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
      {src && !failed && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn(
            "absolute inset-0 size-full object-cover opacity-0 transition-opacity duration-(--duration-slow) ease-smooth",
            loaded && "opacity-100",
          )}
        />
      )}
    </div>
  );
}
