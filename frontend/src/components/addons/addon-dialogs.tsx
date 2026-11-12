import { useMutation, useQueryClient } from "@tanstack/react-query";
import { openURL } from "@/lib/open-url";
import { CircleCheck, ExternalLink, Settings2, TriangleAlert } from "lucide-react";
import { type RefObject, useState } from "react";

import type { Addon } from "@bindings/store";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { type Manifest, manifestQuery } from "@/lib/addon-protocol";
import { addonLink, configureUrl } from "@/lib/addons";

// Installing an addon by its address, and reconfiguring one (#38). Both read
// the manifest first, fresh from the addon, and save nothing until it reads:
// an address that isn't an addon is refused here, not installed broken.

// Labels are Mona Sans caps; the values are mono (codes).
const label = "type-eyebrow";

// What an addon offers, in a line each: the content types it knows, and the
// resources it answers.
export function ManifestFacts({ manifest }: { manifest: Manifest }) {
  const resources = [...new Set(manifest.resources.map((r) => r.name))];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tnum text-small text-muted-foreground">
      <dt className={label}>Types</dt>
      <dd className="text-foreground/80">{manifest.types.join(", ") || "none"}</dd>
      <dt className={label}>Resources</dt>
      <dd className="text-foreground/80">{resources.join(", ") || "none"}</dd>
    </dl>
  );
}

// Whether an addon has a configure page: it says it does, or it answers
// nothing until configured.
export function configurable(manifest: Manifest | undefined): boolean {
  return Boolean(
    manifest?.behaviorHints.configurable || manifest?.behaviorHints.configurationRequired,
  );
}

function openConfigure(url: string) {
  void openURL(configureUrl(url));
}

// Reads the manifest at what the user typed, skipping the cache.
function useManifestCheck() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: string) => {
      const url = addonLink(input);
      if (!url) throw new Error("That isn’t an addon address.");
      // Not retried: someone is waiting, and a typo won't fix itself.
      const manifest = await queryClient.fetchQuery({
        ...manifestQuery(url),
        staleTime: 0,
        retry: false,
      });
      return { url, manifest };
    },
  });
}

type Checked = { url: string; manifest: Manifest };

// The address field both dialogs use, with the check's outcome under it.
function AddressField({
  value,
  onChange,
  description,
}: {
  value: string;
  onChange: (value: string) => void;
  description: string;
}) {
  return (
    <Field name="url" className="items-stretch">
      <FieldLabel>Address</FieldLabel>
      <Input
        type="text"
        inputMode="url"
        required
        value={value}
        onValueChange={onChange}
        placeholder="https://addon.example/manifest.json"
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="none"
        className="rounded-xl before:rounded-[calc(var(--radius-xl)-1px)] **:data-[slot=input]:h-11 **:data-[slot=input]:leading-11"
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
      />
      <FieldError />
      <FieldDescription>{description}</FieldDescription>
    </Field>
  );
}

function CheckedAddon({ checked }: { checked: Checked }) {
  const { manifest } = checked;
  return (
    <Alert variant="success">
      <CircleCheck />
      <AlertTitle>
        {manifest.name} <span className="tnum text-small">v{manifest.version}</span>
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        {manifest.description && <span className="line-clamp-3">{manifest.description}</span>}
        <ManifestFacts manifest={manifest} />
      </AlertDescription>
    </Alert>
  );
}

function NeedsConfiguring({ url }: { url: string }) {
  return (
    <Alert variant="warning">
      <Settings2 />
      <AlertTitle>Configure it first</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        <span>
          This addon answers nothing until it is set up. Its configure page opens in your browser;
          when it gives you an address, paste it above.
        </span>
        <Button size="sm" variant="outline" type="button" onClick={() => openConfigure(url)}>
          <ExternalLink aria-hidden />
          Open configure page
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function Problem({ title, description }: { title: string; description: string }) {
  return (
    <Alert variant="error">
      <TriangleAlert />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

// Installs an addon at the end of the list. `installed` is the list now, to
// refuse a second copy before Go does.
export function InstallDialog({
  open,
  onOpenChange,
  installed,
  onInstall,
  returnFocusTo,
}: {
  open: boolean;
  // Where focus goes on Escape or Close: the button that opened it. Base UI
  // can't find it for a dialog with no trigger of its own.
  returnFocusTo?: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  installed: readonly Addon[];
  onInstall: (addon: Addon) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup finalFocus={returnFocusTo}>
        {/* Mounted while open, so each opening starts empty. */}
        {open && <InstallForm installed={installed} onInstall={onInstall} />}
      </DialogPopup>
    </Dialog>
  );
}

function InstallForm({
  installed,
  onInstall,
}: {
  installed: readonly Addon[];
  onInstall: (addon: Addon) => void;
}) {
  const [input, setInput] = useState("");
  const check = useManifestCheck();
  // The check is for what was typed when it ran; typing again starts over.
  const [checkedInput, setCheckedInput] = useState<string>();
  const current = checkedInput === input ? check : undefined;
  const checked = current?.data;
  const duplicate = checked && installed.some((a) => a.url === checked.url);
  const needsConfig = checked?.manifest.behaviorHints.configurationRequired === true;
  const ready = checked && !duplicate && !needsConfig;

  const submit = () => {
    if (ready) {
      onInstall({ url: checked.url, name: checked.manifest.name, enabled: true });
      return;
    }
    setCheckedInput(input);
    check.mutate(input);
  };

  return (
    <Form className="contents" onFormSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Install an addon</DialogTitle>
        <DialogDescription>
          Paste the addon’s address: its manifest URL or a stremio:// link. Peli comes with no
          addons; you choose your own.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-5">
        <AddressField
          value={input}
          onChange={setInput}
          description="An address with your settings in it can hold an account key, so Peli shows only its host."
        />
        {current?.isError && (
          <Problem title="Couldn’t read that addon" description={current.error.message} />
        )}
        {checked && !duplicate && <CheckedAddon checked={checked} />}
        {duplicate && (
          <Problem
            title="Already installed"
            description="This profile already has an addon at that address."
          />
        )}
        {checked && needsConfig && !duplicate && <NeedsConfiguring url={checked.url} />}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="ghost" size="lg" />}>
          Cancel
        </DialogClose>
        <Button type="submit" size="lg" loading={check.isPending} disabled={input.trim() === ""}>
          {ready ? "Install" : "Check"}
        </Button>
      </DialogFooter>
    </Form>
  );
}

// Reconfigures an installed addon: opens its configure page, then takes the
// address the page gives and puts it in the addon's place. The new address
// must be the same addon (the same manifest id), when the old one loaded.
export function ConfigureDialog({
  addon,
  manifest,
  installed,
  onOpenChange,
  onSave,
}: {
  // The addon being configured, or none when closed.
  addon: Addon | undefined;
  manifest: Manifest | undefined;
  installed: readonly Addon[];
  onOpenChange: (open: boolean) => void;
  onSave: (addon: Addon) => void;
}) {
  // The addon goes away with the dialog, but focus is returned after.
  const [lastUrl, setLastUrl] = useState(addon?.url);
  if (addon && addon.url !== lastUrl) setLastUrl(addon.url);

  return (
    <Dialog open={addon !== undefined} onOpenChange={onOpenChange}>
      {/* The row's menu is gone by now (it opened this), so focus goes to its
          button by the row's address. A saved change moves the address, and
          then focus takes Base UI's default. */}
      <DialogPopup
        finalFocus={() =>
          lastUrl
            ? document.querySelector<HTMLElement>(
                `[data-addon-url="${CSS.escape(lastUrl)}"] [aria-label^="More for"]`,
              )
            : null
        }
      >
        {addon && (
          <ConfigureForm
            key={addon.url}
            addon={addon}
            manifest={manifest}
            installed={installed}
            onSave={onSave}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function ConfigureForm({
  addon,
  manifest,
  installed,
  onSave,
}: {
  addon: Addon;
  manifest: Manifest | undefined;
  installed: readonly Addon[];
  onSave: (addon: Addon) => void;
}) {
  const name = addon.name || manifest?.name || "this addon";
  const [input, setInput] = useState("");
  const check = useManifestCheck();
  const [checkedInput, setCheckedInput] = useState<string>();
  const current = checkedInput === input ? check : undefined;
  const checked = current?.data;
  const other = checked && manifest && checked.manifest.id !== manifest.id;
  const duplicate =
    checked && checked.url !== addon.url && installed.some((a) => a.url === checked.url);
  const needsConfig = checked?.manifest.behaviorHints.configurationRequired === true;
  const ready = checked && !other && !duplicate && !needsConfig;

  const submit = () => {
    if (ready) {
      onSave({ url: checked.url, name: checked.manifest.name, enabled: addon.enabled });
      return;
    }
    setCheckedInput(input);
    check.mutate(input);
  };

  return (
    <Form className="contents" onFormSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Configure {name}</DialogTitle>
        <DialogDescription>
          Change its settings on the addon’s own page, in your browser. When it gives you a new
          address, paste it here. The addon keeps its place in your list.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-5">
        <Button
          type="button"
          variant="outline"
          className="self-start"
          onClick={() => openConfigure(addon.url)}
        >
          <ExternalLink aria-hidden />
          Open configure page
        </Button>
        <AddressField
          value={input}
          onChange={setInput}
          description="The address the configure page gives you, often with “Copy link” or “Install”."
        />
        {current?.isError && (
          <Problem title="Couldn’t read that addon" description={current.error.message} />
        )}
        {checked && !other && !duplicate && <CheckedAddon checked={checked} />}
        {other && (
          <Problem
            title="That’s a different addon"
            description={`It’s ${checked.manifest.name}, not ${name}. Install it as a new addon instead.`}
          />
        )}
        {duplicate && !other && (
          <Problem
            title="Already installed"
            description="This profile already has an addon at that address."
          />
        )}
        {checked && needsConfig && !other && !duplicate && <NeedsConfiguring url={checked.url} />}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="ghost" size="lg" />}>
          Cancel
        </DialogClose>
        <Button type="submit" size="lg" loading={check.isPending} disabled={input.trim() === ""}>
          {ready ? "Save" : "Check"}
        </Button>
      </DialogFooter>
    </Form>
  );
}
