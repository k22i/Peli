import { GallerySection } from "@/components/gallery/gallery-section";
import { ScrollRail } from "@/components/media/scroll-rail";

const people = [
  { name: "Mara Quill", character: "The Keeper" },
  { name: "Tomas Reyes", character: "Harbor master" },
  { name: "Ines Okafor", character: "Radio voice" },
  { name: "Jun Park", character: "Deckhand" },
  { name: "Elin Voss", character: "The Courier" },
  { name: "Dario Mensah", character: "Captain Hale" },
  { name: "Noor Haddad", character: "Surveyor" },
  { name: "Pia Lindqvist", character: "Lamp-maker" },
  { name: "Ravi Anand", character: "The Stranger" },
  { name: "Sol Ferreira", character: "Ferryman" },
  { name: "Wren Alder", character: "Child" },
  { name: "Hugo Marsh", character: "Doctor" },
];

const hues = [200, 25, 300, 150, 340, 60, 240, 10, 180, 280, 100, 320];

// A ScrollRail with something other than chips (#116, #117): the title page's
// cast. Arrows and the edge fades show where there is more; a vertical wheel
// still scrolls the page; focusing an item brings it into view.
export function RailSample() {
  return (
    <GallerySection
      title="Scroll rail"
      description="One line of anything that scrolls sideways: chips, source pills, cast. The first item lines up with the page text; the rest run out to the window edge, fading at an end that has more. Hover for the material-pop arrows; Tab works too, and a vertical wheel still scrolls the page (sideways swipes and Shift+wheel move the rail)."
      bleed
    >
      <ScrollRail label="Cast">
        <ul className="flex shrink-0 gap-4 py-3">
          {people.map(({ name, character }, index) => (
            <li key={name} className="flex w-36 shrink-0 flex-col items-center gap-3">
              <button
                type="button"
                aria-label={name}
                className="grid size-32 place-items-center rounded-full type-row text-white shadow-card"
                style={{
                  background: `linear-gradient(135deg, oklch(0.62 0.14 ${hues[index]}), oklch(0.32 0.07 ${hues[index]}))`,
                }}
              >
                {name
                  .split(" ")
                  .map((word) => word.charAt(0))
                  .join("")}
              </button>
              <div className="flex w-full flex-col items-center text-center">
                <span className="line-clamp-2 type-item">{name}</span>
                <span className="line-clamp-2 text-small text-muted-foreground">{character}</span>
              </div>
            </li>
          ))}
        </ul>
      </ScrollRail>
    </GallerySection>
  );
}
