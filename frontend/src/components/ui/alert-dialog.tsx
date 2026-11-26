"use client";

import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import type React from "react";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { markSheetOpen } from "@/lib/sheets";
import { useCompactShell } from "@/lib/shell-mode";

export const AlertDialogCreateHandle: typeof AlertDialogPrimitive.createHandle =
  AlertDialogPrimitive.createHandle;

export const AlertDialog: typeof AlertDialogPrimitive.Root = AlertDialogPrimitive.Root;

export const AlertDialogPortal: typeof AlertDialogPrimitive.Portal = AlertDialogPrimitive.Portal;

export function AlertDialogTrigger(props: AlertDialogPrimitive.Trigger.Props): React.ReactElement {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

export function AlertDialogBackdrop({
  className,
  ...props
}: AlertDialogPrimitive.Backdrop.Props): React.ReactElement {
  return (
    <AlertDialogPrimitive.Backdrop
      className={cn(
        "fixed inset-0 z-50 bg-black/55 backdrop-blur-[3px] transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-[-webkit-touch-callout:none]:absolute",
        className,
      )}
      data-slot="alert-dialog-backdrop"
      {...props}
    />
  );
}

export function AlertDialogViewport({
  className,
  ...props
}: AlertDialogPrimitive.Viewport.Props): React.ReactElement {
  return (
    <AlertDialogPrimitive.Viewport
      className={cn(
        "fixed inset-0 z-50 grid grid-rows-[1fr_auto_3fr] justify-items-center p-4",
        className,
      )}
      data-slot="alert-dialog-viewport"
      {...props}
    />
  );
}

export function AlertDialogPopup({
  className,
  bottomStickOnMobile = true,
  portalProps,
  ...props
}: AlertDialogPrimitive.Popup.Props & {
  bottomStickOnMobile?: boolean;
  portalProps?: AlertDialogPrimitive.Portal.Props;
}): React.ReactElement {
  // On the compact shell the popup sits on the screen's bottom edge (it is
  // stuck there under 640 pt), where the floating tab bar (#129) would cover
  // its buttons: hold a hideTabBar() request while it is up, as dialog.tsx
  // does for its own.
  const overBar = useCompactShell() && bottomStickOnMobile;
  return (
    <AlertDialogPortal {...portalProps}>
      {overBar && <HoldTabBar />}
      <AlertDialogBackdrop />
      <AlertDialogViewport
        className={cn(bottomStickOnMobile && "max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12")}
      >
        <AlertDialogPrimitive.Popup
          className={cn(
            "relative row-start-2 flex max-h-full min-h-0 w-full min-w-0 max-w-lg origin-center flex-col rounded-3xl border bg-popover text-popover-foreground shadow-pop opacity-[calc(1-var(--nested-dialogs))] transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-3xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:opacity-0 data-starting-style:opacity-0 sm:scale-[calc(1-0.1*var(--nested-dialogs))] sm:data-ending-style:scale-98 sm:data-starting-style:scale-98 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            bottomStickOnMobile &&
              "max-sm:max-w-none max-sm:origin-bottom max-sm:rounded-none max-sm:border-x-0 max-sm:border-t max-sm:border-b-0 max-sm:data-ending-style:translate-y-4 max-sm:data-starting-style:translate-y-4 max-sm:before:hidden max-sm:before:rounded-none",
            className,
          )}
          data-slot="alert-dialog-popup"
          {...props}
        />
      </AlertDialogViewport>
    </AlertDialogPortal>
  );
}

// Nothing to draw: it lives as long as the popup it is rendered in, which is
// only while the dialog is open (the portal renders no children when it is
// shut), and releases the bar when it goes.
function HoldTabBar(): null {
  useEffect(() => markSheetOpen(), []);
  return null;
}

export function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn("flex flex-col gap-2 p-6 text-center max-sm:pb-4 sm:text-left", className)}
      data-slot="alert-dialog-header"
      {...props}
    />
  );
}

export function AlertDialogFooter({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "default" | "bare";
}): React.ReactElement {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-3xl)-1px)] *:data-[slot=button]:h-10 *:data-[slot=button]:px-[calc(--spacing(3.5)-1px)]",
        variant === "default" && "border-t py-4",
        variant === "bare" && "pb-6",
        className,
      )}
      data-slot="alert-dialog-footer"
      {...props}
    />
  );
}

export function AlertDialogTitle({
  className,
  ...props
}: AlertDialogPrimitive.Title.Props): React.ReactElement {
  return (
    <AlertDialogPrimitive.Title
      className={cn("font-display text-[1.875rem] leading-[1.05] tracking-[-0.005em]", className)}
      data-slot="alert-dialog-title"
      {...props}
    />
  );
}

export function AlertDialogDescription({
  className,
  ...props
}: AlertDialogPrimitive.Description.Props): React.ReactElement {
  return (
    <AlertDialogPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="alert-dialog-description"
      {...props}
    />
  );
}

export function AlertDialogClose(props: AlertDialogPrimitive.Close.Props): React.ReactElement {
  return <AlertDialogPrimitive.Close data-slot="alert-dialog-close" {...props} />;
}

export {
  AlertDialogPrimitive,
  AlertDialogBackdrop as AlertDialogOverlay,
  AlertDialogPopup as AlertDialogContent,
};
