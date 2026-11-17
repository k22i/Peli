import { ChevronsUpDownIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { BottomSheet, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { SheetCheck, SheetRow } from "@/components/ui/responsive-menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  selectTriggerIconClassName,
  selectTriggerVariants,
} from "@/components/ui/select";
import { useCompactShell } from "@/lib/shell-mode";
import { cn } from "@/lib/utils";

export type SelectOption<V extends string> = { value: V; label: string };

// A Select that is the coss popup on a wide screen and a bottom sheet of
// rows, the chosen one checked, on the compact iOS shell (#134). Desktop
// renders exactly what the callers wrote before: <Select items value
// onValueChange> with a <SelectTrigger> and one <SelectItem> per option.
// `onValueChange` gets what Base UI gives (null when cleared), so callers
// keep their own rule for it. `title` heads the sheet; without one it's the
// text of the `aria-labelledby` element (a setting's name).
export function ResponsiveSelect<V extends string>({
  items,
  value,
  onValueChange,
  disabled,
  title,
  size,
  className,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
}: {
  items: readonly SelectOption<V>[];
  value: V;
  onValueChange: (value: V | null) => void;
  disabled?: boolean | undefined;
  title?: string | undefined;
  size?: "default" | "sm" | "lg";
  className?: string;
  id?: string | undefined;
  "aria-label"?: string | undefined;
  "aria-labelledby"?: string | undefined;
  "aria-describedby"?: string | undefined;
}) {
  const compact = useCompactShell();
  const [open, setOpen] = useState(false);
  const [heading, setHeading] = useState(title);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  if (!compact) {
    return (
      <Select
        items={items}
        value={value}
        disabled={disabled}
        onValueChange={(next: V | null) => onValueChange(next)}
      >
        <SelectTrigger
          id={id}
          aria-label={ariaLabel}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          size={size}
          className={className}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    );
  }
  const chosen = items.find((item) => item.value === value);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        id={id}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-popup-open={open ? "" : undefined}
        data-disabled={disabled ? "" : undefined}
        data-slot="select-trigger"
        className={cn(selectTriggerVariants({ size }), className)}
        onClick={() => {
          setHeading(
            title ??
              (labelledBy ? document.getElementById(labelledBy)?.textContent?.trim() : undefined),
          );
          setOpen(true);
        }}
      >
        <span data-slot="select-value" className="flex-1 truncate">
          {chosen?.label ?? ""}
        </span>
        <ChevronsUpDownIcon aria-hidden className={selectTriggerIconClassName} />
      </button>
      <BottomSheet
        open={open}
        onOpenChange={setOpen}
        label={heading ? undefined : ariaLabel}
        labelledBy={heading ? titleId : labelledBy}
        header={heading ? <BottomSheetTitle id={titleId}>{heading}</BottomSheetTitle> : undefined}
        initialFocus={() =>
          document.querySelector<HTMLElement>(
            '[data-slot="bottom-sheet"] [role="radio"][aria-checked="true"]',
          ) ?? true
        }
        finalFocus={() => trigger.current ?? true}
      >
        <div role="radiogroup" aria-label={heading ?? ariaLabel} className="flex flex-col">
          {items.map((item) => {
            const checked = item.value === value;
            return (
              <SheetRow
                key={item.value}
                role="radio"
                aria-checked={checked}
                trailing={checked ? <SheetCheck /> : null}
                onClick={() => {
                  onValueChange(item.value);
                  setOpen(false);
                }}
              >
                {item.label}
              </SheetRow>
            );
          })}
        </div>
      </BottomSheet>
    </>
  );
}
