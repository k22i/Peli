import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  CircleAlert,
  Ellipsis,
  GripVertical,
  Settings2,
  Trash2,
} from "lucide-react";
import { useState, type DragEvent } from "react";

import type { Addon } from "@bindings/store";
import { configurable, ManifestFacts } from "@/components/addons/addon-dialogs";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { type Manifest, manifestQuery } from "@/lib/addon-protocol";
import { cn } from "@/lib/utils";

// One installed addon in the manager (#38): its name, version, what it
// offers, and why its manifest didn't load. Reordered by dragging the grip,
// or with the arrow keys on it; the menu does the same and more.

// Where a dragged addon would land, relative to this row.
export type DropEdge = "before" | "after";

export type AddonRowActions = {
  move: (to: number) => void;
  enable: (enabled: boolean) => void;
  configure: (manifest: Manifest | undefined) => void;
  remove: () => void;
};

export function AddonRow({
  addon,
  index,
  count,
  actions,
  dropEdge,
  dragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  addon: Addon;
  index: number;
  count: number;
  actions: AddonRowActions;
  dropEdge: DropEdge | undefined;
  dragging: boolean;
  onDragStart: () => void;
  onDragOver: (edge: DropEdge) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const manifest = useQuery(manifestQuery(addon.url));
  const name = addon.name || manifest.data?.name || host(addon.url);
  // Only the grip starts a drag, so text and controls work as usual.
  const [armed, setArmed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);

  const keyMove = (key: string) => {
    if (key === "ArrowUp") return index - 1;
    if (key === "ArrowDown") return index + 1;
    if (key === "Home") return 0;
    if (key === "End") return count - 1;
    return undefined;
  };

  const dragOver = (event: DragEvent<HTMLLIElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const box = event.currentTarget.getBoundingClientRect();
    onDragOver(event.clientY < box.top + box.height / 2 ? "before" : "after");
  };

  return (
    // A drop target for the pointer; the grip's arrow keys do the same.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <li
      aria-label={name}
      draggable={armed}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        // Some engines start a drag only with data set.
        event.dataTransfer.setData("text/plain", name);
        onDragStart();
      }}
      onDragOver={dragOver}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onDragEnd={() => {
        setArmed(false);
        onDragEnd();
      }}
      className={cn(
        "relative flex items-start gap-2 bg-card py-3.5 ps-1.5 pe-3 first:rounded-t-xl last:rounded-b-xl",
        dragging && "opacity-50",
        dropEdge === "before" &&
          "before:absolute before:inset-x-3 before:-top-px before:h-0.5 before:rounded-full before:bg-brand",
        dropEdge === "after" &&
          "after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:rounded-full after:bg-brand",
      )}
    >
      <button
        type="button"
        aria-label={`Reorder ${name}`}
        aria-describedby="addon-reorder-help"
        className="mt-0.5 grid size-7 shrink-0 cursor-grab place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        onPointerDown={() => setArmed(true)}
        onPointerUp={() => setArmed(false)}
        onKeyDown={(event) => {
          const to = keyMove(event.key);
          if (to === undefined) return;
          event.preventDefault();
          if (to >= 0 && to < count && to !== index) actions.move(to);
        }}
      >
        <GripVertical aria-hidden className="size-4" />
      </button>

      {manifest.data?.logo && !logoFailed ? (
        <img
          src={manifest.data.logo}
          alt=""
          className="mt-0.5 size-7 shrink-0 rounded-md bg-muted object-contain"
          onError={() => setLogoFailed(true)}
        />
      ) : (
        <span
          aria-hidden
          className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-muted font-heading text-sm text-muted-foreground"
        >
          {name.charAt(0).toUpperCase()}
        </span>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-1 ps-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          {manifest.data && (
            <span className="shrink-0 font-mono text-meta text-muted-foreground">
              v{manifest.data.version}
            </span>
          )}
          {manifest.isPending && <Spinner className="size-3.5 self-center text-muted-foreground" />}
        </div>
        {manifest.data?.description && (
          <p className="line-clamp-1 text-sm text-muted-foreground">{manifest.data.description}</p>
        )}
        {manifest.data && <ManifestFacts manifest={manifest.data} />}
        {/* The host only: the path can hold the user's settings and keys. */}
        <span className="truncate font-mono text-meta text-muted-foreground/80">
          {host(addon.url)}
        </span>
        {manifest.isError && (
          <p className="mt-1 flex items-start gap-1.5 text-sm text-destructive-foreground">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              Couldn’t load its manifest. {manifest.error.message} It stays installed, here and on
              your other devices.
            </span>
          </p>
        )}
      </div>

      <Switch
        aria-label={`Use ${name}`}
        className="mt-1.5"
        checked={addon.enabled}
        onCheckedChange={actions.enable}
      />
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${name}`} />}
        >
          <Ellipsis aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end" className="w-48">
          {(configurable(manifest.data) || manifest.isError) && (
            <>
              <MenuItem onClick={() => actions.configure(manifest.data)}>
                <Settings2 aria-hidden />
                Configure…
              </MenuItem>
              <MenuSeparator />
            </>
          )}
          <MenuItem disabled={index === 0} onClick={() => actions.move(0)}>
            <ArrowUpToLine aria-hidden />
            Move to top
          </MenuItem>
          <MenuItem disabled={index === 0} onClick={() => actions.move(index - 1)}>
            <ArrowUp aria-hidden />
            Move up
          </MenuItem>
          <MenuItem disabled={index === count - 1} onClick={() => actions.move(index + 1)}>
            <ArrowDown aria-hidden />
            Move down
          </MenuItem>
          <MenuItem disabled={index === count - 1} onClick={() => actions.move(count - 1)}>
            <ArrowDownToLine aria-hidden />
            Move to bottom
          </MenuItem>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={actions.remove}>
            <Trash2 aria-hidden />
            Remove
          </MenuItem>
        </MenuPopup>
      </Menu>
    </li>
  );
}

// The addon's host, for showing: "v3-cinemeta.strem.io".
export function host(url: string): string {
  try {
    return new URL(url.replace(/^stremio:\/\//, "https://")).host;
  } catch {
    return url;
  }
}
