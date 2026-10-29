import { parentSteps, usePinSteps } from "@/components/account/pin-dialog";
import { host } from "@/components/addons/addon-row";
import { toastManager } from "@/components/ui/toast";
import { needsParentPin, profileProblem } from "@/lib/account";
import { type AddonEdit, useEditAddons } from "@/lib/addons";
import type { Addon, Profile } from "@bindings/store";

export const addonLabel = (addon: Addon) => addon.name || host(addon.url);

// Runs a profile's addon edits for the addon manager (#38) and Home's
// empty state (#39). `dialog` asks for the parent PIN and must be rendered.
export function useAddonEdits(profile: Profile) {
  const edit = useEditAddons(profile.id);
  const { ask, dialog } = usePinSteps();

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

  const install = (addon: Addon) =>
    void run({ kind: "install", addon }).then(
      (done) =>
        done && toastManager.add({ type: "success", title: `Installed ${addonLabel(addon)}` }),
    );

  return { run, install, dialog };
}
