import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";

import { BottomSheet } from "@/components/ui/bottom-sheet";
import {
  ContextMenu,
  ContextMenuGroup,
  ContextMenuGroupLabel,
  ContextMenuItem,
  ContextMenuLinkItem,
  ContextMenuPopup,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubPopup,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuLinkItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu";
import { haptic } from "@/lib/haptics";
import { useCompactShell } from "@/lib/shell-mode";
import { cn } from "@/lib/utils";

// Menus that are popovers on a wide screen and bottom sheets on the compact
// iOS shell (#134). A caller writes its items once with the ResponsiveMenu*
// parts below; inside `ResponsiveMenu` (a button's menu) or
// `ResponsiveContextMenu` (a card's right-click or long-press menu) they
// render as Base UI menu items on desktop and the iPad full screen, exactly
// as the coss parts did, and as 50 pt list rows in a `BottomSheet` on the
// iPhone. A submenu becomes a second page of the same sheet, with a Back
// row. Choosing a row runs its action and closes the sheet.

type Mode = "menu" | "context" | "sheet";
const ModeContext = createContext<Mode>("menu");

// Which shape the items are drawn in, for a caller that draws something
// different in a sheet (the profile menu's header).
export const useMenuMode = (): Mode => useContext(ModeContext);

type SheetNav = {
  page: string | undefined;
  push: (page: string) => void;
  back: () => void;
  close: () => void;
};
const SheetNavContext = createContext<SheetNav | undefined>(undefined);
// The page the items around belong to: undefined for the sheet's first.
const PageContext = createContext<string | undefined>(undefined);

// Whether an item in a sheet is on the page showing.
function useOnPage(): boolean {
  const nav = useContext(SheetNavContext);
  const page = useContext(PageContext);
  return nav?.page === page;
}

type PopupPlacement = {
  align?: ComponentProps<typeof MenuPopup>["align"];
  side?: ComponentProps<typeof MenuPopup>["side"];
  sideOffset?: ComponentProps<typeof MenuPopup>["sideOffset"];
};

type TriggerProps = Omit<ComponentProps<"button">, "className"> & {
  className?: string | undefined;
  render?: ReactElement;
};

// A button's menu: `trigger` is what MenuTrigger took (props, `render`, its
// children). `label` names the sheet for VoiceOver; `header` shows above its
// rows.
export function ResponsiveMenu({
  trigger,
  label,
  header,
  popupClassName,
  children,
  ...placement
}: PopupPlacement & {
  trigger: TriggerProps;
  label: string;
  header?: ReactNode;
  popupClassName?: string;
  children: ReactNode;
}) {
  const compact = useCompactShell();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLElement>(null);
  if (!compact) {
    return (
      <Menu>
        <MenuTrigger {...trigger} />
        <MenuPopup className={popupClassName} {...placement}>
          <ModeContext value="menu">{children}</ModeContext>
        </MenuPopup>
      </Menu>
    );
  }
  return (
    <>
      <SheetTrigger {...trigger} ref={button} open={open} onOpen={() => setOpen(true)} />
      <SheetMenu
        open={open}
        onOpenChange={setOpen}
        label={label}
        header={header}
        finalFocus={() => button.current ?? true}
      >
        {children}
      </SheetMenu>
    </>
  );
}

function SheetTrigger({
  render,
  open,
  onOpen,
  ref,
  ...props
}: TriggerProps & { open: boolean; onOpen: () => void; ref: Ref<HTMLElement> }) {
  return useRender({
    defaultTagName: "button",
    render,
    ref,
    props: mergeProps<"button">(
      {
        type: "button",
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        onClick: onOpen,
        ...({ "data-popup-open": open ? "" : undefined } as object),
      },
      props,
    ),
  });
}

// How long a finger rests on a card before its menu opens, as Base UI's
// context menu and iOS have it.
export const longPressMs = 500;
// A finger that moves this far is scrolling, not pressing.
const pressSlop = 10;

// A card's menu: `children` is the card; `items` the menu. On desktop a
// right-click (or the context-menu key, see `openOnContextKey`) opens it at
// the pointer; on the compact iOS shell a 500 ms press opens it as a sheet,
// with the card shrinking to 0.97 while pressed and a light haptic. Focus
// goes back to `finalFocus` on close.
export function ResponsiveContextMenu({
  children,
  items,
  label,
  header,
  popupClassName,
  finalFocus,
  triggerRef,
}: {
  children: ReactNode;
  items: ReactNode;
  label: string;
  header?: ReactNode;
  popupClassName?: string;
  finalFocus?: () => HTMLElement | boolean;
  triggerRef?: Ref<HTMLDivElement>;
}) {
  const compact = useCompactShell();
  const [open, setOpen] = useState(false);
  const press = useLongPress(() => {
    setOpen(true);
    haptic("light");
  });
  if (!compact) {
    return (
      <ContextMenu>
        <ContextMenuTrigger ref={triggerRef} className="contents">
          {children}
        </ContextMenuTrigger>
        <ContextMenuPopup className={popupClassName} finalFocus={finalFocus}>
          <ModeContext value="context">{items}</ModeContext>
        </ContextMenuPopup>
      </ContextMenu>
    );
  }
  return (
    <>
      <div
        ref={triggerRef}
        data-slot="press-scale"
        data-pressing={press.pressing || undefined}
        className="contents motion-safe:*:transition-[scale] motion-safe:*:duration-200 data-pressing:*:scale-[0.97]"
        {...press.handlers}
        onContextMenu={(event) => {
          // The keyboard's context-menu key (openOnContextKey), a pointer's
          // secondary click on an iPad in a narrow window.
          event.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </div>
      <SheetMenu
        open={open}
        onOpenChange={setOpen}
        label={label}
        header={header}
        finalFocus={finalFocus}
      >
        {items}
      </SheetMenu>
    </>
  );
}

// A press that lasts `longPressMs` without moving: `pressing` while the
// finger is down, then `onLongPress`, and the click that the lift would make
// is swallowed (so the card doesn't open as well).
export function useLongPress(onLongPress: () => void) {
  const [pressing, setPressing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = useRef<{ x: number; y: number }>(undefined);
  const fired = useRef(false);
  const fire = useRef(onLongPress);
  fire.current = onLongPress;

  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    start.current = undefined;
    setPressing(false);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  return {
    pressing,
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (event.pointerType === "mouse" || event.button !== 0) return;
        fired.current = false;
        start.current = { x: event.clientX, y: event.clientY };
        setPressing(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = undefined;
          start.current = undefined;
          fired.current = true;
          setPressing(false);
          fire.current();
        }, longPressMs);
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        const from = start.current;
        if (!from) return;
        if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > pressSlop) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
      onClickCapture: (event: { preventDefault: () => void; stopPropagation: () => void }) => {
        if (!fired.current) return;
        fired.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}

// The sheet around a menu's items: the page stack for submenus.
function SheetMenu({
  open,
  onOpenChange,
  label,
  header,
  finalFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  header?: ReactNode;
  finalFocus?: (() => HTMLElement | boolean) | undefined;
  children: ReactNode;
}) {
  const [pages, setPages] = useState<string[]>([]);
  // Where focus goes once a page changes: the new page's Back row, or the
  // row that opened the page left.
  const [focus, setFocus] = useState<string>();
  useEffect(() => {
    if (!open) setPages([]);
  }, [open]);
  useEffect(() => {
    if (!focus) return;
    const target = document.querySelector<HTMLElement>(`[data-sheet-focus="${CSS.escape(focus)}"]`);
    target?.focus();
    setFocus(undefined);
  }, [focus]);
  const nav: SheetNav = {
    page: pages.at(-1),
    push: (page) => {
      setPages((stack) => [...stack, page]);
      setFocus(`back:${page}`);
    },
    back: () => {
      setPages((stack) => stack.slice(0, -1));
      const left = pages.at(-1);
      if (left) setFocus(`sub:${left}`);
    },
    close: () => onOpenChange(false),
  };
  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      label={label}
      header={pages.length === 0 ? header : undefined}
      finalFocus={finalFocus}
    >
      <div className="flex flex-col">
        <ModeContext value="sheet">
          <SheetNavContext value={nav}>
            <PageContext value={undefined}>{children}</PageContext>
          </SheetNavContext>
        </ModeContext>
      </div>
    </BottomSheet>
  );
}

// One row of a sheet: 50 pt, a 17 pt label, an optional 22 pt leading icon
// (the first svg child) and something at the end (a check, a chevron).
export const sheetRowClassName =
  "flex min-h-[50px] w-full items-center gap-3 rounded-xl px-3 text-start text-[17px] leading-[22px] text-foreground outline-none select-none transition-colors duration-(--duration-fast) active:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 aria-disabled:pointer-events-none aria-disabled:opacity-40 [&>svg]:pointer-events-none [&>svg]:size-[22px] [&>svg]:shrink-0 [&>svg]:text-foreground/70 data-[variant=destructive]:text-destructive data-[variant=destructive]:[&>svg]:text-destructive";

export function SheetRow({
  children,
  trailing,
  variant = "default",
  className,
  ...props
}: ComponentProps<"button"> & {
  trailing?: ReactNode;
  variant?: "default" | "destructive";
  "data-sheet-focus"?: string;
}) {
  return (
    <button
      type="button"
      data-slot="sheet-row"
      data-variant={variant}
      className={cn(sheetRowClassName, className)}
      {...props}
    >
      {children}
      {trailing !== undefined && (
        <span className="ms-auto flex shrink-0 items-center ps-2 text-foreground/60 [&>svg]:size-5">
          {trailing}
        </span>
      )}
    </button>
  );
}

// The check at the end of the chosen row.
export function SheetCheck() {
  return <Check aria-hidden className="text-sun-ink" strokeWidth={2.5} />;
}

type ItemProps = {
  onClick?: (() => void) | undefined;
  disabled?: boolean | undefined;
  variant?: "default" | "destructive";
  className?: string;
  children: ReactNode;
};

export function ResponsiveMenuItem({ onClick, disabled, variant, className, children }: ItemProps) {
  const mode = useMenuMode();
  const nav = useContext(SheetNavContext);
  const onPage = useOnPage();
  if (mode === "menu") {
    return (
      <MenuItem onClick={onClick} disabled={disabled} variant={variant} className={className}>
        {children}
      </MenuItem>
    );
  }
  if (mode === "context") {
    return (
      <ContextMenuItem onClick={onClick} disabled={disabled} variant={variant} className={className}>
        {children}
      </ContextMenuItem>
    );
  }
  if (!onPage) return null;
  return (
    <SheetRow
      disabled={disabled}
      variant={variant}
      onClick={() => {
        onClick?.();
        nav?.close();
      }}
    >
      {children}
    </SheetRow>
  );
}

// An item that is a link: `render` is the router's <Link>.
export function ResponsiveMenuLinkItem({
  render,
  children,
  ...props
}: {
  render: ReactElement;
  children: ReactNode;
  "aria-keyshortcuts"?: string;
}) {
  const mode = useMenuMode();
  if (mode === "menu") {
    return (
      <MenuLinkItem render={render} {...props}>
        {children}
      </MenuLinkItem>
    );
  }
  if (mode === "context") {
    return (
      <ContextMenuLinkItem render={render} {...props}>
        {children}
      </ContextMenuLinkItem>
    );
  }
  return <SheetLinkRow render={render}>{children}</SheetLinkRow>;
}

function SheetLinkRow({ render, children }: { render: ReactElement; children: ReactNode }) {
  const nav = useContext(SheetNavContext);
  const onPage = useOnPage();
  const element = useRender({
    defaultTagName: "a",
    render,
    props: {
      className: sheetRowClassName,
      "data-slot": "sheet-row",
      onClick: () => nav?.close(),
      children,
    } as ComponentProps<"a">,
  });
  return onPage ? element : null;
}

export function ResponsiveMenuGroup({ children }: { children: ReactNode }) {
  const mode = useMenuMode();
  if (mode === "menu") return <MenuGroup>{children}</MenuGroup>;
  if (mode === "context") return <ContextMenuGroup>{children}</ContextMenuGroup>;
  return <SheetGroup>{children}</SheetGroup>;
}

function SheetGroup({ children }: { children: ReactNode }) {
  // A group with nothing on this page draws nothing (`empty:hidden`).
  return (
    <div role="group" className="flex flex-col empty:hidden">
      {children}
    </div>
  );
}

// A group's heading: 13 pt uppercase in a sheet. `className` styles the
// popover's label only.
export function ResponsiveMenuGroupLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const mode = useMenuMode();
  const onPage = useOnPage();
  if (mode === "menu") return <MenuGroupLabel className={className}>{children}</MenuGroupLabel>;
  if (mode === "context") {
    return <ContextMenuGroupLabel className={className}>{children}</ContextMenuGroupLabel>;
  }
  if (!onPage) return null;
  return <SheetLabel>{children}</SheetLabel>;
}

function SheetLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pt-3 pb-1.5 text-[13px] leading-4 font-[560] tracking-[0.02em] text-muted-foreground uppercase">
      {children}
    </div>
  );
}

// Between groups: a line in a popover, an 8 pt band across a sheet (as iOS
// context menus part their sections).
export function ResponsiveMenuSeparator() {
  const mode = useMenuMode();
  const onPage = useOnPage();
  if (mode === "menu") return <MenuSeparator />;
  if (mode === "context") return <ContextMenuSeparator />;
  if (!onPage) return null;
  return (
    <div
      role="separator"
      data-slot="sheet-separator"
      className="-mx-4 my-1.5 h-2 shrink-0 bg-foreground/6"
    />
  );
}

// A keyboard hint: popovers only.
export function ResponsiveMenuShortcut({ children }: { children: ReactNode }) {
  const mode = useMenuMode();
  if (mode === "menu") return <MenuShortcut aria-hidden>{children}</MenuShortcut>;
  if (mode === "context") return <ContextMenuShortcut aria-hidden>{children}</ContextMenuShortcut>;
  return null;
}

type RadioContext = { value: unknown; onValueChange: (value: unknown) => void };
const RadioGroupContext = createContext<RadioContext | undefined>(undefined);

export function ResponsiveMenuRadioGroup({
  value,
  onValueChange,
  children,
}: RadioContext & { children: ReactNode }) {
  const mode = useMenuMode();
  if (mode === "menu") {
    return (
      <MenuRadioGroup value={value} onValueChange={(next) => onValueChange(next)}>
        {children}
      </MenuRadioGroup>
    );
  }
  if (mode === "context") {
    return (
      <ContextMenuRadioGroup value={value} onValueChange={(next) => onValueChange(next)}>
        {children}
      </ContextMenuRadioGroup>
    );
  }
  return (
    <RadioGroupContext value={{ value, onValueChange }}>
      <div role="radiogroup" className="flex flex-col empty:hidden">
        {children}
      </div>
    </RadioGroupContext>
  );
}

export function ResponsiveMenuRadioItem({
  value,
  children,
}: {
  value: unknown;
  children: ReactNode;
}) {
  const mode = useMenuMode();
  const group = useContext(RadioGroupContext);
  const nav = useContext(SheetNavContext);
  const onPage = useOnPage();
  if (mode === "menu") return <MenuRadioItem value={value}>{children}</MenuRadioItem>;
  if (mode === "context") return <ContextMenuRadioItem value={value}>{children}</ContextMenuRadioItem>;
  if (!onPage) return null;
  const checked = Object.is(group?.value, value);
  return (
    <SheetRow
      role="radio"
      aria-checked={checked}
      trailing={checked ? <SheetCheck /> : null}
      onClick={() => {
        group?.onValueChange(value);
        nav?.close();
      }}
    >
      {children}
    </SheetRow>
  );
}

// A submenu: `label` is its row (an icon and the text); `title` names its
// page in a sheet, which `children` fill under a Back row.
export function ResponsiveMenuSub({
  label,
  title,
  popupClassName,
  children,
}: {
  label: ReactNode;
  title: string;
  popupClassName?: string;
  children: ReactNode;
}) {
  const mode = useMenuMode();
  const nav = useContext(SheetNavContext);
  const onPage = useOnPage();
  const id = useId();
  if (mode === "menu") {
    return (
      <MenuSub>
        <MenuSubTrigger>{label}</MenuSubTrigger>
        <MenuSubPopup className={popupClassName}>{children}</MenuSubPopup>
      </MenuSub>
    );
  }
  if (mode === "context") {
    return (
      <ContextMenuSub>
        <ContextMenuSubTrigger>{label}</ContextMenuSubTrigger>
        <ContextMenuSubPopup className={popupClassName}>{children}</ContextMenuSubPopup>
      </ContextMenuSub>
    );
  }
  const showing = nav?.page === id;
  return (
    <>
      {onPage && (
        <SheetRow
          data-sheet-focus={`sub:${id}`}
          aria-haspopup="true"
          trailing={<ChevronRight aria-hidden />}
          onClick={() => nav?.push(id)}
        >
          {label}
        </SheetRow>
      )}
      <PageContext value={id}>
        {showing && (
          <>
            <SheetRow data-sheet-focus={`back:${id}`} onClick={() => nav?.back()}>
              <ChevronLeft aria-hidden className="text-sun-ink!" />
              <span className="text-sun-ink">Back</span>
            </SheetRow>
            <SheetLabel>{title}</SheetLabel>
          </>
        )}
        {children}
      </PageContext>
    </>
  );
}
