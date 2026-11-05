import { cn } from "@/lib/utils";

// The brand tone: two soft pools of the lagoon accent, high left and mid
// right. Sinag's own glow, for pages with no artwork of their own.
const brandGlow = [
  "radial-gradient(60% 55% at 20% 0%, color-mix(in srgb, var(--brand) 18%, transparent), transparent 70%)",
  "radial-gradient(50% 45% at 85% 30%, color-mix(in srgb, var(--brand) 10%, transparent), transparent 70%)",
].join(", ");

// Fades the layer out towards the page below.
const fade = "linear-gradient(to bottom, #000 30%, transparent)";

// An ambient backdrop (#111): a tall wash of colour at the top of a page,
// behind its content, so glass and text sit on something that has life.
//
// - `art` blurs the image into a haze of its colours (`filter`, not
//   `backdrop-filter`, so it costs one blurred bitmap, not a live backdrop).
//   Without a `src` it shows the brand glow, so a page that waits for its
//   artwork still has a backdrop.
// - `brand` is the glow alone.
//
// The parent must be `relative isolate`, so the layer sits behind the page's
// content and not behind the app's background. With reduced transparency the
// blur goes and the layer is a faint flat tint.
export function Ambient({
  src,
  tone = "art",
  className,
}: {
  src?: string | undefined;
  tone?: "art" | "brand";
  className?: string;
}) {
  const art = tone === "art" && src;
  return (
    <div
      aria-hidden
      data-slot="ambient"
      data-tone={art ? "art" : "brand"}
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 -z-10 h-[60vh] overflow-hidden",
        className,
      )}
      style={{ maskImage: fade, WebkitMaskImage: fade }}
    >
      {art ? (
        <div
          className="absolute -inset-16 bg-cover bg-center opacity-25 blur-[60px] saturate-[1.4] dark:opacity-35 reduced-transparency:opacity-15 reduced-transparency:blur-none"
          style={{ backgroundImage: `url("${src}")` }}
        />
      ) : (
        <div
          className="absolute inset-0 reduced-transparency:opacity-50"
          style={{ backgroundImage: brandGlow }}
        />
      )}
    </div>
  );
}
