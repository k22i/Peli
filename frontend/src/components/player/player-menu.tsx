import { Menu } from "@base-ui/react/menu";
import { Check, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { sheetSurface } from "@/components/player/panel-controls";
import { cn } from "@/lib/utils";

// The dock's menus (Speed, More): Base UI menus on the sheets' surface, so
// they read over the video like the panels do, with a ring on the item the
// keys reach. The page knows when one is open (onOpenChange) and leaves the
// keys to it meanwhile.

const popupClass = cn(
  "dark flex max-h-(--available-height) min-w-56 origin-(--transform-origin) flex-col overflow-y-auto overscroll-contain rounded-3xl p-1.5 text-white outline-none",
  sheetSurface,
  "transition-[opacity,scale] duration-150 ease-out data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
  "motion-reduce:transition-opacity motion-reduce:data-ending-style:scale-100 motion-reduce:data-starting-style:scale-100",
);

const itemClass =
  "flex min-h-10 shrink-0 cursor-default items-center gap-3 rounded-2xl px-3 text-[0.875rem] font-[560] text-white/85 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-disabled:opacity-40 data-highlighted:bg-white/10 data-highlighted:text-white [&_svg]:size-4.5 [&_svg]:shrink-0";

export function PlayerMenu({
  label,
  trigger,
  triggerClassName,
  open,
  onOpenChange,
  shortcut,
  lit = false,
  side = "top",
  align = "end",
  children,
}: {
  // The trigger's name: "Playback speed", "More".
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shortcut?: string;
  // A dot on the trigger: something in the menu is on.
  lit?: boolean;
  // Where the menu opens from its trigger: above (the dock), or below (the
  // touch player's top row, #130).
  side?: "top" | "bottom";
  align?: "start" | "end";
  children: ReactNode;
}) {
  return (
    <Menu.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Menu.Trigger
        aria-label={label}
        aria-keyshortcuts={shortcut}
        className={cn(
          "relative grid h-10 min-w-10 place-items-center rounded-full text-white/90 outline-none transition-[background-color,color,scale] hover:bg-white/12 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 data-popup-open:bg-white data-popup-open:text-black motion-safe:active:scale-90 [&_svg]:size-5",
          triggerClassName,
        )}
      >
        {trigger}
        {lit && !open && (
          <span
            aria-hidden
            className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-[#ffb547]"
          />
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side={side} align={align} sideOffset={12} collisionPadding={12}>
          <Menu.Popup aria-label={label} className={popupClass}>
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function PlayerMenuItem({
  icon,
  children,
  hint,
  onClick,
  disabled,
  closeOnClick = true,
}: {
  icon?: ReactNode;
  children: ReactNode;
  // Said at the end of the row: a key, a time.
  hint?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  closeOnClick?: boolean;
}) {
  return (
    <Menu.Item
      className={itemClass}
      onClick={onClick}
      disabled={disabled}
      closeOnClick={closeOnClick}
    >
      {icon ?? <span aria-hidden className="size-4.5 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint !== undefined && " "}
      {hint !== undefined && <span className="text-small text-white/50 tnum">{hint}</span>}
    </Menu.Item>
  );
}

export function PlayerMenuRadioGroup<T extends string | number>({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  children: ReactNode;
}) {
  return (
    <Menu.RadioGroup
      aria-label={label}
      value={value}
      // The items' values are the group's T.
      onValueChange={(next: T) => onChange(next)}
      className="flex flex-col"
    >
      {children}
    </Menu.RadioGroup>
  );
}

export function PlayerMenuRadioItem({
  value,
  children,
  hint,
}: {
  value: string | number;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <Menu.RadioItem value={value} className={itemClass} closeOnClick>
      <span className="grid size-4.5 shrink-0 place-items-center">
        <Menu.RadioItemIndicator>
          <Check aria-hidden />
        </Menu.RadioItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint !== undefined && " "}
      {hint !== undefined && <span className="text-small text-white/50 tnum">{hint}</span>}
    </Menu.RadioItem>
  );
}

export function PlayerMenuCheckboxItem({
  checked,
  onChange,
  children,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <Menu.CheckboxItem
      checked={checked}
      onCheckedChange={(next) => onChange(next)}
      className={itemClass}
      closeOnClick
    >
      <span className="grid size-4.5 shrink-0 place-items-center">
        <Menu.CheckboxItemIndicator>
          <Check aria-hidden />
        </Menu.CheckboxItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint !== undefined && " "}
      {hint !== undefined && <span className="text-small text-white/50 tnum">{hint}</span>}
    </Menu.CheckboxItem>
  );
}

// A row that opens a menu of its own beside it: Chapters, Sleep timer.
export function PlayerSubmenu({
  icon,
  label,
  hint,
  disabled,
  children,
}: {
  icon: ReactNode;
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className={itemClass} disabled={disabled}>
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {hint !== undefined && " "}
        {hint !== undefined && <span className="text-small text-white/50 tnum">{hint}</span>}
        <ChevronRight aria-hidden className="text-white/50 rtl:rotate-180" />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner side="inline-start" align="end" sideOffset={8} collisionPadding={12}>
          <Menu.Popup aria-label={label} className={cn(popupClass, "max-w-80")}>
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}

export function PlayerMenuSeparator() {
  return <Menu.Separator className="mx-3 my-1 h-px shrink-0 bg-white/10" />;
}

export function PlayerMenuGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Menu.Group className="flex flex-col">
      <Menu.GroupLabel className="px-3 pt-2 pb-1 type-eyebrow text-white/55">
        {label}
      </Menu.GroupLabel>
      {children}
    </Menu.Group>
  );
}
