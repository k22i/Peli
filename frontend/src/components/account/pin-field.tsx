import { useEffect, useRef } from "react";

import { PinKeypad } from "@/components/account/pin-keypad";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const pinLength = 4;

// A profile's 4-digit PIN field and keypad (#25). The input is read-only and
// the digits are handled on the wrapper, so typing works with a physical
// keyboard wherever focus sits in the field, and with the on-screen keypad.
// It is visually hidden (#123): four dots show how many digits are in, and
// shake when `shake` goes up, the way a wrong PIN does (none under reduced
// motion).
export function PinField({
  value,
  disabled,
  shake = 0,
  onValueChange,
}: {
  value: string;
  disabled: boolean;
  shake?: number;
  onValueChange: (digits: string) => void;
}) {
  const wrapper = useRef<HTMLDivElement>(null);

  // A dialog's own focus handling can land elsewhere, so focus the input once
  // it has settled; a physical keyboard then types straight into the PIN.
  useEffect(() => {
    const frame = requestAnimationFrame(() => wrapper.current?.querySelector("input")?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const set = (digits: string) => onValueChange(digits.replace(/\D/g, "").slice(0, pinLength));

  const press = (digit: string) => {
    if (!disabled) set(value + digit);
  };

  const backspace = () => {
    if (!disabled) set(value.slice(0, -1));
  };

  return (
    // The wrapper is a layout div: it only forwards keys to the read-only
    // input and the keypad, so it isn't an interactive widget of its own.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={wrapper}
      className="flex w-full flex-col items-center gap-6"
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key.length === 1 && event.key >= "0" && event.key <= "9") {
          event.preventDefault();
          press(event.key);
        } else if (event.key === "Backspace") {
          event.preventDefault();
          backspace();
        }
      }}
    >
      <Field name="pin" className="items-center">
        <FieldLabel className="sr-only">PIN</FieldLabel>
        <Input
          value={value}
          readOnly
          unstyled
          inputMode="numeric"
          autoComplete="off"
          maxLength={pinLength}
          className="sr-only"
        />
      </Field>
      {/* A new key restarts the shake. */}
      <div
        key={shake}
        aria-hidden
        data-slot="pin-dots"
        className={cn(
          "flex h-6 items-center gap-4",
          shake > 0 && "motion-safe:animate-toast-error-odd",
        )}
      >
        {Array.from({ length: pinLength }, (_, i) => (
          <span
            key={i}
            data-filled={i < value.length || undefined}
            className="size-3.5 rounded-full border-2 border-foreground/40 transition-colors duration-(--duration-fast) data-filled:border-foreground data-filled:bg-foreground"
          />
        ))}
      </div>
      <PinKeypad disabled={disabled} onPress={press} onBackspace={backspace} />
    </div>
  );
}
