import { Delete } from "lucide-react";

import { Button } from "@/components/ui/button";

const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0"];

// The shared 3×4 numeric keypad for PIN entry (#25), used by the unlock
// dialog and the set/change/clear wizard. Buttons keep the accessible names
// "1".."9", "0" and "Backspace" so both flows can be driven the same way.
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
    <div className="grid grid-cols-3 gap-2">
      {keys.map((key) =>
        key === "" ? (
          <span key="spacer" aria-hidden />
        ) : (
          <Button
            key={key}
            variant="outline"
            className="size-14 text-lg"
            disabled={disabled}
            onClick={() => onPress(key)}
          >
            {key}
          </Button>
        ),
      )}
      <Button
        variant="ghost"
        className="size-14"
        aria-label="Backspace"
        disabled={disabled}
        onClick={onBackspace}
      >
        <Delete />
      </Button>
    </div>
  );
}
