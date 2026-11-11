import { cn } from "@/lib/utils";

// A sunrise along the bottom edge: a low warm arc of light, for the screens
// that come before the app (welcome, sign-in, who's watching).
const sunrise = [
  "radial-gradient(70% 55% at 50% 115%, color-mix(in srgb, var(--sun) 38%, transparent), transparent 70%)",
  "radial-gradient(40% 30% at 50% 108%, color-mix(in srgb, var(--sun) 55%, transparent), transparent 70%)",
].join(", ");

const fadeDown = "linear-gradient(to bottom, #000 25%, transparent)";

// A wash of colour behind a page.
//  art  the title's art, blurred far out of focus, fading down the page
//  sun  the sunrise (also while art is missing)
export function Ambient({
  src,
  tone = "art",
  className,
}: {
  src?: string | undefined;
  tone?: "art" | "sun";
  className?: string;
}) {
  const art = tone === "art" && src;
  return (
    <div
      aria-hidden
      data-slot="ambient"
      data-tone={art ? "art" : "sun"}
      className={cn(
        "pointer-events-none absolute inset-x-0 -z-10 overflow-hidden",
        art ? "top-0 h-[70vh]" : "inset-y-0",
        className,
      )}
      style={art ? { maskImage: fadeDown, WebkitMaskImage: fadeDown } : undefined}
    >
      {art ? (
        <div
          className="absolute -inset-24 bg-cover bg-center opacity-30 blur-[80px] saturate-150 dark:opacity-45 reduced-transparency:opacity-15 reduced-transparency:blur-none"
          style={{ backgroundImage: `url("${src}")` }}
        />
      ) : (
        <div
          className="absolute inset-0 reduced-transparency:opacity-50"
          style={{ backgroundImage: sunrise }}
        />
      )}
    </div>
  );
}
