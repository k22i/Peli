import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Service as Diagnostics } from "@bindings/diagnostics";
import { SettingRow, SettingsGroup } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import {
  allocateUntilKilled,
  installDevCrash,
  memoryWarning,
  panicInGo,
  recoveredPanicInGo,
  rejectAPromise,
} from "@/lib/dev-crash";
import { runTabLoop } from "@/lib/dev-loop";
import { isIOS } from "@/lib/platform";

export const diagnosticsInfoQuery = queryOptions({
  queryKey: ["diagnostics", "info"],
  queryFn: () => Diagnostics.Info(),
  staleTime: Number.POSITIVE_INFINITY,
});

// Written at launch: a crash can only be the last run's.
export const lastCrashQuery = queryOptions({
  queryKey: ["diagnostics", "last-crash"],
  queryFn: () => Diagnostics.LastCrash(),
  staleTime: Number.POSITIVE_INFINITY,
});

const crashTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

// Settings › About › Diagnostics (#127), on iOS: share the logs (and the
// last crash), so a problem on the phone can be reported without a Mac.
// The desktop's Settings are unchanged.
export function DiagnosticsRows() {
  if (!isIOS()) return null;
  return <DiagnosticsOnIOS />;
}

function DiagnosticsOnIOS() {
  const info = useQuery(diagnosticsInfoQuery);
  const crash = useQuery(lastCrashQuery);
  const share = useMutation({
    mutationFn: () => Diagnostics.ShareLogs(),
    onError: () => toastManager.add({ type: "error", title: "Couldn’t share the logs" }),
  });
  if (!info.data?.logs) return null;

  return (
    <>
      <SettingsGroup
        title="Diagnostics"
        footer="The logs stay on this device until you share them. They don’t include passwords or keys."
      >
        {crash.data && (
          <SettingRow
            id="last-crash"
            label="Last crash"
            description={
              <time dateTime={crash.data.time}>{crashTime.format(new Date(crash.data.time))}</time>
            }
          />
        )}
        <SettingRow
          id="share-logs"
          label="Logs"
          description="What Peli did recently, with the last crash, to send with a problem report."
        >
          <Button
            variant="outline"
            size="sm"
            aria-describedby="share-logs-description"
            loading={share.isPending}
            onClick={() => share.mutate()}
          >
            Share logs
          </Button>
        </SettingRow>
      </SettingsGroup>
      {info.data.dev && <CrashTests />}
    </>
  );
}

function Thrower(): never {
  throw new Error("pelidev: a render error, on purpose");
}

// The rig's crash commands, in a pelidev build only: on a device there is
// no cmd.js, so this is where they are run from.
function CrashTests() {
  const [boom, setBoom] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();
  useEffect(() => {
    const dev = installDevCrash();
    dev.throwInRender = () => setBoom(true);
  }, []);

  const tests: { id: string; label: string; description: string; run: () => unknown }[] = [
    {
      id: "crash-render",
      label: "Throw in render",
      description: "Shows the error screen.",
      run: () => setBoom(true),
    },
    {
      id: "crash-reject",
      label: "Reject a promise",
      description: "Logged as a frontend error.",
      run: rejectAPromise,
    },
    {
      id: "crash-allocate",
      label: "Allocate until killed",
      description: "WebKit is killed for memory and Peli reloads on this page.",
      run: allocateUntilKilled,
    },
    {
      id: "crash-panic",
      label: "Panic in Go",
      description: "The app closes and leaves a crash file.",
      run: () => panicInGo().catch(() => {}),
    },
    {
      id: "crash-recovered",
      label: "Recovered panic",
      description: "Logged with its stack; the app goes on.",
      run: () => recoveredPanicInGo().catch(() => {}),
    },
    {
      id: "tab-loop",
      label: "Tab loop",
      description:
        "Home, Movies, Shows and Anime, each scrolled three screens, ten times. Every step is logged with memory: share the logs after.",
      run: () => void runTabLoop(router, queryClient),
    },
    {
      id: "crash-memory",
      label: "Memory warning",
      description: "Logs memory and trims the caches.",
      run: () => memoryWarning().catch(() => {}),
    },
  ];

  return (
    <SettingsGroup title="Crash tests (dev build)">
      {boom && <Thrower />}
      {tests.map((test) => (
        <SettingRow key={test.id} id={test.id} label={test.label} description={test.description}>
          <Button
            variant="outline"
            size="sm"
            aria-describedby={`${test.id}-description`}
            onClick={() => void test.run()}
          >
            Run
          </Button>
        </SettingRow>
      ))}
    </SettingsGroup>
  );
}
