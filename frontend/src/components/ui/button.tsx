"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

// Peli's buttons are capsules. Ink (default) is the main action on a page,
// sun the rare call to begin something (sign in, install), light and media
// sit over artwork (Play, and everything beside it).
export const buttonVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-full border border-transparent font-[590] tracking-[-0.005em] outline-none transition-[background-color,color,box-shadow,scale,opacity] duration-(--duration-fast) ease-out-soft motion-safe:active:scale-[0.96] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-45 data-loading:select-none data-loading:text-transparent text-small [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-8.5 px-4",
        icon: "size-8.5",
        "icon-lg": "size-10",
        "icon-sm": "size-7.5",
        "icon-xl": "size-12 [&_svg:not([class*='size-'])]:size-5",
        "icon-xs": "size-6.5 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 px-5 text-body",
        sm: "h-7.5 gap-1.5 px-3",
        xl: "h-12 gap-2.5 px-7 text-[0.9375rem] [&_svg:not([class*='size-'])]:size-[1.125rem]",
        xs: "h-6.5 gap-1 px-2.5 text-tiny [&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/88 data-pressed:bg-primary/88 *:data-[slot=button-loading-indicator]:text-primary-foreground",
        sun: "bg-sun text-sun-foreground shadow-[0_6px_20px_-8px_var(--sun)] hover:brightness-105 data-pressed:brightness-95 *:data-[slot=button-loading-indicator]:text-sun-foreground",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 data-pressed:bg-destructive/90 *:data-[slot=button-loading-indicator]:text-white",
        "destructive-outline":
          "border-destructive/30 text-destructive-foreground hover:bg-destructive/8 data-pressed:bg-destructive/8 *:data-[slot=button-loading-indicator]:text-foreground",
        ghost:
          "text-foreground hover:bg-accent data-pressed:bg-accent *:data-[slot=button-loading-indicator]:text-foreground",
        link: "rounded-md px-0 text-foreground underline-offset-4 motion-safe:active:scale-100 hover:underline data-pressed:underline *:data-[slot=button-loading-indicator]:text-foreground",
        outline:
          "border-input bg-transparent text-foreground hover:bg-accent data-pressed:bg-accent *:data-[slot=button-loading-indicator]:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-foreground/12 data-pressed:bg-foreground/12 *:data-[slot=button-loading-indicator]:text-secondary-foreground",
        light:
          "bg-white text-[#141210] shadow-[0_8px_24px_-10px_rgb(0_0_0/0.6)] hover:bg-white/90 data-pressed:bg-white/90 *:data-[slot=button-loading-indicator]:text-black",
        media:
          "material-media text-white hover:bg-[rgb(60_56_52/0.55)] data-pressed:bg-[rgb(60_56_52/0.55)] *:data-[slot=button-loading-indicator]:text-white",
      },
    },
  },
);

export interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  render,
  children,
  loading = false,
  disabled: disabledProp,
  ...props
}: ButtonProps): React.ReactElement {
  const isDisabled: boolean = Boolean(loading || disabledProp);
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] = render
    ? undefined
    : "button";

  const defaultProps = {
    children: (
      <>
        {children}
        {loading && (
          <Spinner className="pointer-events-none absolute" data-slot="button-loading-indicator" />
        )}
      </>
    ),
    className: cn(buttonVariants({ className, size, variant })),
    "aria-disabled": loading || undefined,
    "data-loading": loading ? "" : undefined,
    "data-slot": "button",
    disabled: isDisabled,
    type: typeValue,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}
