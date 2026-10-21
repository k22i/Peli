import { useEffect, useRef } from "react";

import { PinKeypad } from "@/components/account/pin-keypad";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const pinLength = 4;

// A profile's 4-digit PIN field and keypad (#25). The input is read-only and
// the digits are handled on the wrapper, so typing works with a physical
// keyboard wherever focus sits in the field, and with the on-screen keypad.
export function PinField({
  value,
  disabled,
  onValueChange,
}: {
  value: string;
  disabled: boolean;
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
      className="flex w-full flex-col items-center gap-4"
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
          inputMode="numeric"
          autoComplete="off"
          maxLength={pinLength}
          className="max-w-44 text-center text-xl tracking-[0.5em]"
        />
      </Field>
      <PinKeypad disabled={disabled} onPress={press} onBackspace={backspace} />
    </div>
  );
}
