import { useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import {
  SettingRow,
  SettingsGroup,
  SettingsPaneView,
} from "@/components/settings/settings-section";
import {
  pluginEditProblem,
  pluginsOverviewQuery,
  usePluginEdits,
  type Repository,
} from "@/lib/plugins";

// Settings › Plugins (#57, ADR-0047): the master switch, the repositories a
// profile has installed and the plugins in them. Off until the profile's
// owner turns it on, after a plain warning; kids profiles get no controls.

export const pluginsWarning = {
  title: "Turn on plugins?",
  points: [
    "Plugins are third-party scrapers. They are written by other people, not by Sinag or Nuvio.",
    "Sinag runs each one in a sandbox that keeps it away from your files and your home network, but it doesn’t check what they do.",
    "Plugins can break, return fake or unsafe links, or stop working without notice.",
    "You are responsible for the repositories you install and for what you watch with them.",
  ],
};

// A repository's address without a query or fragment, which can hold a token.
export function sourceOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

export function PluginsPane({
  title,
  profileId,
}: {
  title: string;
  profileId: number | undefined;
}) {
  if (profileId === undefined) {
    return (
      <SettingsPaneView title={title}>
        <Skeleton className="h-48 rounded-2xl" />
      </SettingsPaneView>
    );
  }
  return <LoadedPluginsPane title={title} profileId={profileId} />;
}

function LoadedPluginsPane({ title, profileId }: { title: string; profileId: number }) {
  const overview = useQuery(pluginsOverviewQuery(profileId)).data;
  return (
    <SettingsPaneView
      title={title}
      lead={
        overview &&
        (overview.kids
          ? "Kids profiles don’t use plugins."
          : "Community scrapers that look for more streams, beside your addons. Each profile decides for itself.")
      }
    >
      {overview ? (
        !overview.kids && (
          <PluginGroups
            profileId={profileId}
            enabled={overview.enabled}
            repos={overview.repositories}
          />
        )
      ) : (
        <Skeleton className="h-48 rounded-2xl" />
      )}
    </SettingsPaneView>
  );
}

const fail = (error: unknown) => toastManager.add({ type: "error", ...pluginEditProblem(error) });

function PluginGroups({
  profileId,
  enabled,
  repos,
}: {
  profileId: number;
  enabled: boolean;
  repos: readonly Repository[];
}) {
  const edits = usePluginEdits(profileId);
  const [warning, setWarning] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Repository>();

  return (
    <>
      <SettingsGroup>
        <SettingRow
          id="plugins-enabled"
          label="Use plugins"
          description={
            enabled
              ? "Plugins are asked for streams beside your addons. Turn this off and none is asked."
              : repos.length > 0
                ? `Off. None is asked. ${repos.length === 1 ? "The repository" : `The ${repos.length} repositories`} you added stays here.`
                : "Off. No plugin is ever asked for streams. Turning it on shows a warning first."
          }
        >
          <Switch
            aria-labelledby="plugins-enabled-label"
            aria-describedby="plugins-enabled-description"
            checked={enabled}
            onCheckedChange={(on) => {
              if (on) setWarning(true);
              else edits.setEnabled.mutate(false, { onError: fail });
            }}
          />
        </SettingRow>
      </SettingsGroup>

      {enabled && (
        <>
          {repos.map((repo) => (
            <RepositoryGroup
              key={repo.url}
              repo={repo}
              onEnableRepository={(on) =>
                edits.enableRepository.mutate({ url: repo.url, enabled: on }, { onError: fail })
              }
              onEnablePlugin={(id, on) =>
                edits.enablePlugin.mutate({ id, enabled: on }, { onError: fail })
              }
              onRemove={() => setRemoving(repo)}
            />
          ))}
          <SettingsGroup footer="A repository is a list of plugins at a web address (its manifest.json). They sync with your Nuvio account, so your other devices get the same repositories; which plugins are on, and their settings, stay on this device.">
            <SettingRow
              id="plugins-add"
              label="Add a repository"
              description={
                repos.length === 0
                  ? "Paste the address of a plugin repository’s manifest."
                  : undefined
              }
            >
              <Button
                variant="outline"
                size="sm"
                loading={edits.refresh.isPending}
                disabled={repos.length === 0}
                onClick={() => edits.refresh.mutate(undefined, { onError: fail })}
              >
                <RefreshCw aria-hidden />
                Refresh
              </Button>
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus aria-hidden />
                Add…
              </Button>
            </SettingRow>
          </SettingsGroup>
        </>
      )}

      <AlertDialog open={warning} onOpenChange={setWarning}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{pluginsWarning.title}</AlertDialogTitle>
            <AlertDialogDescription render={<div />}>
              <ul className="flex list-disc flex-col gap-2 ps-5 text-pretty">
                {pluginsWarning.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button
              loading={edits.setEnabled.isPending}
              onClick={() =>
                edits.setEnabled.mutate(true, {
                  onSuccess: () => setWarning(false),
                  onError: fail,
                })
              }
            >
              <ShieldAlert aria-hidden />I understand, turn on
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AddRepositoryDialog profileId={profileId} open={adding} onOpenChange={setAdding} />

      <AlertDialog
        open={removing !== undefined}
        onOpenChange={(open) => !open && setRemoving(undefined)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its plugins stop being asked, and the repository is removed from your Nuvio account
              too, so your other devices lose it. You can add it again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              loading={edits.remove.isPending}
              onClick={() =>
                removing &&
                edits.remove.mutate(removing.url, {
                  onSuccess: () => {
                    setRemoving(undefined);
                    toastManager.add({ type: "success", title: `Removed ${removing.name}` });
                  },
                  onError: fail,
                })
              }
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

// One repository: its name and where it is, its own switch and Remove, then
// its plugins, each on or off.
function RepositoryGroup({
  repo,
  onEnableRepository,
  onEnablePlugin,
  onRemove,
}: {
  repo: Repository;
  onEnableRepository: (enabled: boolean) => void;
  onEnablePlugin: (id: string, enabled: boolean) => void;
  onRemove: () => void;
}) {
  const id = `repo-${repo.url}`;
  const count = repo.plugins?.length ?? 0;
  return (
    <SettingsGroup>
      <SettingRow
        id={id}
        label={repo.name}
        description={
          <>
            <span className="block truncate tnum text-small">{sourceOf(repo.url)}</span>
            {!repo.supported
              ? "Android only: Sinag can’t run it. It stays in your list so your phone keeps it."
              : repo.fetchedAt === 0
                ? "Reading its plugins…"
                : `${count} ${count === 1 ? "plugin" : "plugins"}`}
          </>
        }
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${repo.name}`}
          onClick={onRemove}
        >
          <Trash2 aria-hidden />
        </Button>
        {repo.supported && (
          <Switch
            aria-label={`Use ${repo.name}`}
            checked={repo.enabled}
            onCheckedChange={onEnableRepository}
          />
        )}
      </SettingRow>
      {repo.supported &&
        repo.plugins?.map((plugin) => (
          <SettingRow
            key={plugin.id}
            id={`plugin-${plugin.id}`}
            label={plugin.name}
            description={[
              plugin.version && `v${plugin.version}`,
              plugin.supportedTypes?.join(", "),
              plugin.description,
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            <Switch
              aria-labelledby={`plugin-${plugin.id}-label`}
              checked={plugin.enabled && repo.enabled}
              disabled={!repo.enabled}
              onCheckedChange={(on) => onEnablePlugin(plugin.id, on)}
            />
          </SettingRow>
        ))}
    </SettingsGroup>
  );
}

// Installs a repository by its manifest address. Go reads the manifest first
// and saves nothing unless it lists plugins Sinag can run.
function AddRepositoryDialog({
  profileId,
  open,
  onOpenChange,
}: {
  profileId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        {open && <AddRepositoryForm profileId={profileId} onDone={() => onOpenChange(false)} />}
      </DialogPopup>
    </Dialog>
  );
}

function AddRepositoryForm({ profileId, onDone }: { profileId: number; onDone: () => void }) {
  const { install } = usePluginEdits(profileId);
  const [address, setAddress] = useState("");
  const problem = install.error ? pluginEditProblem(install.error) : undefined;

  return (
    <Form
      className="contents"
      errors={problem ? { address: `${problem.title}. ${problem.description}` } : {}}
      onFormSubmit={() => {
        install.mutate(address, {
          onSuccess: (repo) => {
            onDone();
            toastManager.add({ type: "success", title: `Added ${repo.name}` });
          },
        });
      }}
    >
      <DialogHeader>
        <DialogTitle>Add a plugin repository</DialogTitle>
        <DialogDescription>
          Paste the address of its manifest. Sinag reads the list of plugins first and adds nothing
          unless it finds some it can run. Plugins only run once you add them here, and you can turn
          each one off.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-5">
        <Field name="address" className="items-stretch">
          <FieldLabel>Manifest address</FieldLabel>
          <Input
            type="text"
            inputMode="url"
            required
            value={address}
            onValueChange={(next) => {
              install.reset();
              setAddress(next);
            }}
            placeholder="https://repo.example/manifest.json"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            className="rounded-xl before:rounded-[calc(var(--radius-xl)-1px)] **:data-[slot=input]:h-11 **:data-[slot=input]:leading-11"
            // oxlint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
          />
          <FieldError />
          <FieldDescription>
            Sinag doesn’t vet repositories. Only add ones you trust.
          </FieldDescription>
        </Field>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
        <Button type="submit" loading={install.isPending}>
          Add
        </Button>
      </DialogFooter>
    </Form>
  );
}
