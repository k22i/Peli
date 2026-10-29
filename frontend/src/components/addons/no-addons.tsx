import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Blocks, Plus } from "lucide-react";
import { useState } from "react";

import { InstallDialog } from "@/components/addons/addon-dialogs";
import { useAddonEdits } from "@/components/addons/addon-edits";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { addonsQuery } from "@/lib/addons";
import type { Profile } from "@bindings/store";

// Home when the profile has no addon to browse (#39): Sinag bundles none, so
// a fresh install starts here. It says what addons are and installs one in
// place, or opens the manager; it never names or links to one. A kids
// profile's addons are the parent's to choose, and turned-off addons only
// need turning on.
export function NoAddons({ profile }: { profile: Profile }) {
  const addons = useQuery(addonsQuery(profile.id));
  const edits = useAddonEdits(profile);
  const [installing, setInstalling] = useState(false);
  const installed = addons.data ?? [];

  const manage = (
    <Link to="/addons" className={buttonVariants({ variant: "outline" })}>
      Manage addons
    </Link>
  );
  const { title, description, actions } = profile.kids
    ? {
        title: "Nothing chosen for this profile yet",
        description:
          "A parent chooses the addons a kids profile can see. They can pick some in this profile’s settings.",
        actions: (
          <Link
            to="/profiles"
            search={{ manage: true }}
            className={buttonVariants({ variant: "outline" })}
          >
            Manage profiles
          </Link>
        ),
      }
    : installed.length > 0
      ? {
          title: "Your addons are turned off",
          description: "Turn one on in the addon manager, and its catalogs show up here.",
          actions: manage,
        }
      : {
          title: "Add an addon to start watching",
          description:
            "Sinag comes with no addons and no content of its own. Addons give you catalogs to browse and streams to play. Install one you trust by its address.",
          actions: (
            <>
              <Button onClick={() => setInstalling(true)} disabled={addons.isPending}>
                <Plus aria-hidden />
                Install addon
              </Button>
              {manage}
            </>
          ),
        };

  return (
    <section aria-labelledby="no-addons-title">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Blocks aria-hidden />
          </EmptyMedia>
          <EmptyTitle>
            <h2 id="no-addons-title">{title}</h2>
          </EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center gap-2.5">{actions}</EmptyContent>
      </Empty>
      <InstallDialog
        open={installing}
        onOpenChange={setInstalling}
        installed={installed}
        onInstall={(addon) => {
          setInstalling(false);
          edits.install(addon);
        }}
      />
      {edits.dialog}
    </section>
  );
}
