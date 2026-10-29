import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";

import { parentSteps, usePinSteps } from "@/components/account/pin-dialog";
import { ConfigureDialog, InstallDialog } from "@/components/addons/addon-dialogs";
import { AddonRow, host, type DropEdge } from "@/components/addons/addon-row";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import type { Manifest } from "@/lib/addon-protocol";
import { needsParentPin, profileProblem } from "@/lib/account";
import { addonsQuery, type AddonEdit, useEditAddons } from "@/lib/addons";
import { currentProfileQuery } from "@/lib/profile";
import type { Addon, Profile } from "@bindings/store";

// Reached from the profile menu and Settings.
export const Route = createFileRoute("/addons")({
  component: Addons,
});

// The addon manager (#38): the profile's installed addons, in the order
// catalogs and streams are asked in. For a Nuvio profile it is the same list
// Nuvio shows on the phone and TV, kept in sync by Go (#32); for the Guest it
// stays on this computer. An addon whose manifest doesn't load keeps its
// place and says why.
function Addons() {
  const profile = useQuery(currentProfileQuery).data;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-gutter py-8">
      {profile ? (
        <Manager profile={profile} />
      ) : (
        <>
          <h1 className="font-heading text-title font-stretch-semi-expanded">Addons</h1>
          <Skeleton className="h-40 rounded-xl" />
        </>
      )}
    </div>
  );
}

function syncNote(profile: Profile): string {
  if (profile.nuvioIndex === undefined || profile.nuvioIndex === null) {
    return "On this computer only.";
  }
  return profile.usesPrimaryAddons
    ? "Shared with your first Nuvio profile, and the same on every device."
    : "The same on every device signed in to Nuvio.";
}

const label = (addon: Addon) => addon.name || host(addon.url);

function Manager({ profile }: { profile: Profile }) {
  const addons = useQuery(addonsQuery(profile.id));
  const edit = useEditAddons(profile.id);
  const { ask, dialog } = usePinSteps();
  const [installing, setInstalling] = useState(false);
  const [configuring, setConfiguring] = useState<{ addon: Addon; manifest?: Manifest }>();
  const [announcement, setAnnouncement] = useState("");
  const list = addons.data ?? [];

  // Runs an edit. The parent PIN a kids profile was opened with lasts two
  // minutes, so a refusal for it asks again and retries.
  const run = (change: AddonEdit): Promise<boolean> =>
    edit.mutateAsync(change).then(
      () => true,
      (error: Error) => {
        if (needsParentPin(error)) {
          return new Promise<boolean>((resolve) => {
            ask(parentSteps(profile), () => void run(change).then(resolve));
          });
        }
        toastManager.add({ type: "error", ...profileProblem(error) });
        return false;
      },
    );

  const move = (addon: Addon, to: number) => {
    setAnnouncement(`${label(addon)} moved to position ${to + 1} of ${list.length}.`);
    void run({ kind: "move", url: addon.url, to });
  };

  const remove = (addon: Addon, at: number) => {
    void run({ kind: "remove", url: addon.url }).then((removed) => {
      if (!removed) return;
      toastManager.add({
        type: "success",
        title: `Removed ${label(addon)}`,
        actionProps: {
          children: "Undo",
          onClick: () => void run({ kind: "insert", addon, at }),
        },
      });
    });
  };

  const install = (addon: Addon) => {
    setInstalling(false);
    void run({ kind: "install", addon }).then(
      (done) => done && toastManager.add({ type: "success", title: `Installed ${label(addon)}` }),
    );
  };

  const reconfigure = (url: string, addon: Addon) => {
    setConfiguring(undefined);
    void run({ kind: "reconfigure", url, addon }).then(
      (done) => done && toastManager.add({ type: "success", title: `Saved ${label(addon)}` }),
    );
  };

  // Dragging: which addon, and where it would land.
  const [dragged, setDragged] = useState<number>();
  const [over, setOver] = useState<{ index: number; edge: DropEdge }>();
  const drop = () => {
    if (dragged === undefined || over === undefined) return;
    const addon = list[dragged];
    // The index after the dragged addon leaves its place.
    let to = over.edge === "before" ? over.index : over.index + 1;
    if (dragged < to) to -= 1;
    if (addon && to !== dragged) move(addon, to);
    setDragged(undefined);
    setOver(undefined);
  };

  return (
    <>
      <header className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-title font-stretch-semi-expanded">Addons</h1>
          <p className="text-sm text-muted-foreground">{syncNote(profile)}</p>
        </div>
        <Button onClick={() => setInstalling(true)} disabled={addons.isPending}>
          <Plus aria-hidden />
          Install addon
        </Button>
      </header>

      {addons.isPending ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : addons.isError ? (
        <p className="text-sm text-destructive-foreground">The addons could not be read.</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No addons installed.</p>
      ) : (
        <section className="flex flex-col gap-2">
          <p id="addon-reorder-help" className="text-sm text-muted-foreground">
            Catalogs and streams come from addons in this order. Drag to reorder, or use the arrow
            keys on an addon’s handle.
          </p>
          {/* Dropping is the pointer's way; the handles' arrow keys do the same. */}
          {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <ul
            aria-label="Installed addons"
            className="flex flex-col divide-y rounded-xl border bg-card"
            onDragLeave={(event) => {
              const to = event.relatedTarget;
              if (!(to instanceof Node && event.currentTarget.contains(to))) {
                setOver(undefined);
              }
            }}
          >
            {list.map((addon, index) => (
              <AddonRow
                key={addon.url}
                addon={addon}
                index={index}
                count={list.length}
                dragging={dragged === index}
                dropEdge={
                  dragged !== undefined && over?.index === index && dragged !== index
                    ? over.edge
                    : undefined
                }
                onDragStart={() => setDragged(index)}
                onDragOver={(edge) => setOver({ index, edge })}
                onDrop={drop}
                onDragEnd={() => {
                  setDragged(undefined);
                  setOver(undefined);
                }}
                actions={{
                  move: (to) => move(addon, to),
                  enable: (enabled) => void run({ kind: "enable", url: addon.url, enabled }),
                  configure: (manifest) =>
                    setConfiguring(manifest ? { addon, manifest } : { addon }),
                  remove: () => remove(addon, index),
                }}
              />
            ))}
          </ul>
        </section>
      )}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <InstallDialog
        open={installing}
        onOpenChange={setInstalling}
        installed={list}
        onInstall={install}
      />
      <ConfigureDialog
        addon={configuring?.addon}
        manifest={configuring?.manifest}
        installed={list}
        onOpenChange={(open) => !open && setConfiguring(undefined)}
        onSave={(addon) => configuring && reconfigure(configuring.addon.url, addon)}
      />
      {dialog}
    </>
  );
}
