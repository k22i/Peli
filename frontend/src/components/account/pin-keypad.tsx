import { Delete } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0"];

// A round key that presses in. The tint stays on hover (see glassButton in
// focus-screen.tsx); only a wash marks it.
const key =
  "size-16 rounded-full before:rounded-full transition-transform duration-(--duration-fast) motion-safe:active:scale-95 sm:size-16";

// The shared 3×4 numeric keypad for PIN entry (#25), used by the unlock
// dialog and the set/change/clear wizard, in the style of a lock screen
// (#123): round keys on the thin glass tier. Buttons keep the accessible
// names "1".."9", "0" and "Backspace" so both flows can be driven the same
// way.
export function PinKeypad({
  disabled,
  onPress,
  onBackspace,
}: {
  disabled: boolean;
  onPress: (digit: string) => void;
  onBackspace: () => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-4">
      {keys.map((digit) =>
        digit === "" ? (
          <span key="spacer" aria-hidden />
        ) : (
          <Button
            key={digit}
            variant="ghost"
            className={cn(
              key,
              "glass-thin border-transparent text-heading hover:bg-(--glass-thin) hover:before:bg-foreground/8 data-pressed:bg-(--glass-thin)",
            )}
            disabled={disabled}
            onClick={() => onPress(digit)}
          >
            {digit}
          </Button>
        ),
      )}
      <Button
        variant="ghost"
        className={cn(key, "[&_svg:not([class*='size-'])]:size-5")}
        aria-label="Backspace"
        disabled={disabled}
        onClick={onBackspace}
      >
        <Delete />
      </Button>
    </div>
  );
}
