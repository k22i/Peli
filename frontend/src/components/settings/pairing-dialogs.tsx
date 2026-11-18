import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RefreshCw, ScanLine, Settings2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { formatLeft, useSecondsLeft } from "@/components/settings/tracking-dialogs";
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
import { Input } from "@/components/ui/input";
import { ResponsiveSelect } from "@/components/ui/responsive-select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import {
  appliedMessage,
  Pairing,
  pairingCodePrefix,
  pairingLabel,
  pairingProblem,
  profileServices,
  qrImage,
  Shell,
  type PairingProblem,
} from "@/lib/pairing";
import { isIOS } from "@/lib/platform";
import { useCompactShell } from "@/lib/shell-mode";
import { markSheetOpen } from "@/lib/sheets";
import type { Choice, Device, PairCode, Summary } from "@bindings/pairing";

// Device pairing (#133, ADR-0061). The camera always scans: on an iPhone or
// iPad, "Copy from another device" opens the camera, and "Add to another
// device" shows a code or scans a Mac's. A Mac shows a code either way, and
// a phrase for another Mac to type.

// On the compact iOS shell the dialog sits at the bottom, where the floating
// tab bar would cover its buttons: hold a sheet's hideTabBar() request while
// it's open, as #134's bottom sheets do.
function useHideTabBar(open: boolean) {
  const compact = useCompactShell();
  useEffect(() => (open && compact ? markSheetOpen() : undefined), [open, compact]);
}

// --- Add to another device (the side with the connections) -----------------

export function AddDeviceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useHideTabBar(open);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void Pairing.Cancel();
        onOpenChange(next);
      }}
    >
      <DialogPopup sheet className="sm:max-w-md">
        {open && <AddDevice />}
      </DialogPopup>
    </Dialog>
  );
}

function AddDevice() {
  const offer = useQuery({
    queryKey: ["pairing", "offer"],
    queryFn: () => Pairing.Offer(),
    staleTime: 0,
    gcTime: 0,
  });
  const profiles = offer.data?.profiles ?? [];
  const [picked, setPicked] = useState<Set<number>>();
  const [tmdb, setTmdb] = useState<boolean>();
  const chosen = picked ?? new Set(profiles.map((p) => p.profileId));
  const withTmdb = tmdb ?? offer.data?.tmdbKey ?? false;
  const choice: Choice = { profileIds: [...chosen], tmdbKey: withTmdb };

  const [code, setCode] = useState<PairCode>();
  const [sentTo, setSentTo] = useState<Device>();
  const wait = useMutation({ mutationFn: () => Pairing.WaitSent() });
  const start = useMutation({
    mutationFn: () => Pairing.StartSending(choice, pairingLabel()),
    onSuccess: (next) => {
      setCode(next);
      wait.reset();
      wait.mutate(undefined, { onSuccess: setSentTo });
    },
  });
  // A phone sending to a Mac scans the Mac's "Copy from" code.
  const scan = useMutation({
    mutationFn: async () => {
      const text = await Shell.ScanQR(pairingCodePrefix);
      return text ? Pairing.SendTo(text, choice, pairingLabel()) : null;
    },
    onSuccess: (device) => device && setSentTo(device),
  });
  const secondsLeft = useSecondsLeft(code?.expiresAt);
  const expired = code !== undefined && secondsLeft === 0 && !sentTo;
  const problem = pairingProblem(start.error ?? wait.error ?? scan.error, true);
  const nothing = offer.data && profiles.length === 0 && !offer.data.tmdbKey;
  const empty = chosen.size === 0 && !withTmdb;

  const toggle = (id: number, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add to another device</DialogTitle>
        <DialogDescription>
          {sentTo
            ? "Done."
            : code
              ? "Scan this code with Peli on the other device: Settings › Integrations › Copy from another device."
              : "Copy SIMKL, AniList and the TMDB key to your other device over this Wi-Fi. Nothing passes through a server."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-5">
        {sentTo ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <Check className="size-8 text-sun-ink" aria-hidden />
            <p className="font-medium">Sent to {sentTo.deviceName}</p>
            <p className="text-body text-muted-foreground">
              If that wasn’t you, disconnect SIMKL here and choose Everywhere.
            </p>
          </div>
        ) : code ? (
          <ShowCode code={code} expired={expired} secondsLeft={secondsLeft} sending />
        ) : offer.isPending ? (
          <Spinner className="mx-auto size-6 text-muted-foreground" />
        ) : nothing ? (
          <p className="text-body text-muted-foreground">
            Nothing to send yet. Connect SIMKL or AniList on a profile here, or add a TMDB key.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {profiles.map((p) => (
              <ChoiceRow
                key={p.profileId}
                id={`pair-profile-${p.profileId}`}
                label={p.name}
                description={[
                  [p.simkl && "SIMKL", p.anilist && "AniList"].filter(Boolean).join(" and "),
                  p.localOnly && "the other device picks a profile for it",
                ]
                  .filter(Boolean)
                  .join(" · ")}
                checked={chosen.has(p.profileId)}
                onChange={(on) => toggle(p.profileId, on)}
              />
            ))}
            {offer.data?.tmdbKey && (
              <ChoiceRow
                id="pair-tmdb"
                label="TMDB key"
                description="For logos, backdrops and cast photos."
                checked={withTmdb}
                onChange={setTmdb}
              />
            )}
            <p className="text-small text-muted-foreground">Kids profiles are never sent.</p>
          </div>
        )}
        {problem && <ProblemAlert problem={problem} />}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="ghost" />}>
          {sentTo ? "Close" : "Cancel"}
        </DialogClose>
        {!sentTo && !code && isIOS() && !nothing && (
          <Button
            type="button"
            variant="outline"
            disabled={empty || offer.isPending}
            loading={scan.isPending}
            onClick={() => scan.mutate()}
          >
            <ScanLine />
            Scan a Mac’s code
          </Button>
        )}
        {!sentTo && (!code || expired || problem) && !nothing && (
          <Button
            type="button"
            disabled={empty || offer.isPending}
            loading={start.isPending}
            onClick={() => start.mutate()}
          >
            {code ? <RefreshCw /> : null}
            {code ? "New code" : "Show code"}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function ChoiceRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p id={`${id}-label`} className="font-medium">
          {label}
        </p>
        {description && (
          <p id={`${id}-description`} className="text-small text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <Switch
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-description` : undefined}
        checked={checked}
        onCheckedChange={onChange}
      />
    </div>
  );
}

// The QR code, the phrase (a Mac sending), and the countdown.
function ShowCode({
  code,
  expired,
  secondsLeft,
  sending,
}: {
  code: PairCode;
  expired: boolean;
  secondsLeft: number;
  sending: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative size-52 rounded-2xl bg-white p-3">
        <img
          src={qrImage(code.size, code.path)}
          alt="Pairing code"
          className={expired ? "size-full opacity-15 blur-[2px]" : "size-full"}
        />
        {expired && (
          <p className="absolute inset-0 m-auto flex items-center justify-center font-medium text-neutral-900">
            The code expired
          </p>
        )}
      </div>
      {sending && code.phrase && !expired && (
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-small text-muted-foreground">On another Mac, type these words:</p>
          <p className="font-mono text-lg font-medium select-text">{code.phrase}</p>
        </div>
      )}
      {!expired && (
        <p className="flex items-center gap-2 text-body text-muted-foreground">
          <Spinner className="size-4" aria-hidden />
          Waiting for the other device ·{" "}
          <span className="tabular-nums">{formatLeft(secondsLeft)}</span>
        </p>
      )}
    </div>
  );
}

function ProblemAlert({ problem }: { problem: PairingProblem }) {
  return (
    <Alert variant="error">
      <TriangleAlert />
      <AlertTitle>{problem.title}</AlertTitle>
      {(problem.description || problem.settings) && (
        <AlertDescription className="flex flex-col items-start gap-2">
          {problem.description}
          {problem.settings && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void Shell.OpenAppSettings()}
            >
              <Settings2 />
              Open Settings
            </Button>
          )}
        </AlertDescription>
      )}
    </Alert>
  );
}

// --- Copy from another device (the side that receives) -----------------------

export function CopyDeviceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useHideTabBar(open);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void Pairing.Cancel();
        onOpenChange(next);
      }}
    >
      <DialogPopup sheet className="sm:max-w-md">
        {open && (
          <CopyDevice
            onDone={() => {
              // Stops this Mac's own code too, after copying by phrase.
              void Pairing.Cancel();
              onOpenChange(false);
            }}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function CopyDevice({ onDone }: { onDone: () => void }) {
  const [summary, setSummary] = useState<Summary>();
  if (summary) return <ConfirmCopy summary={summary} onDone={onDone} />;
  return isIOS() ? <ScanToCopy onSummary={setSummary} /> : <ShowToCopy onSummary={setSummary} />;
}

// iPhone or iPad: the camera reads the other device's code.
function ScanToCopy({ onSummary }: { onSummary: (s: Summary) => void }) {
  const scan = useMutation({
    mutationFn: async () => {
      const text = await Shell.ScanQR(pairingCodePrefix);
      return text ? Pairing.ReceiveFrom(text, pairingLabel()) : null;
    },
    onSuccess: (summary) => summary && onSummary(summary),
  });
  // oxlint-disable-next-line react/exhaustive-deps -- scan once, as the dialog opens.
  useEffect(() => scan.mutate(), []);
  const problem = pairingProblem(scan.error, false);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Copy from another device</DialogTitle>
        <DialogDescription>
          On the device that has your connections, open Settings › Integrations › Add to another
          device, then scan its code. Both need the same Wi-Fi.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4">
        {scan.isPending && (
          <p className="flex items-center gap-2 text-body text-muted-foreground">
            <Spinner className="size-4" aria-hidden />
            Copying…
          </p>
        )}
        {problem && <ProblemAlert problem={problem} />}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
        <Button type="button" loading={scan.isPending} onClick={() => scan.mutate()}>
          <ScanLine />
          Scan code
        </Button>
      </DialogFooter>
    </>
  );
}

// A Mac: shows a code for a phone or tablet to scan and send to, or takes
// the phrase another Mac shows.
function ShowToCopy({ onSummary }: { onSummary: (s: Summary) => void }) {
  const phraseAvailable = useQuery({
    queryKey: ["pairing", "phrase-available"],
    queryFn: () => Pairing.PhraseAvailable(),
    staleTime: Infinity,
  }).data;
  const wait = useMutation({ mutationFn: () => Pairing.WaitReceived(), onSuccess: onSummary });
  const start = useMutation({
    mutationFn: () => Pairing.StartReceiving(pairingLabel()),
    onSuccess: () => {
      wait.reset();
      wait.mutate();
    },
  });
  // oxlint-disable-next-line react/exhaustive-deps -- show a code once, as the dialog opens.
  useEffect(() => start.mutate(), []);
  const [phrase, setPhrase] = useState("");
  const typed = useMutation({
    mutationFn: () => Pairing.ReceivePhrase(phrase, pairingLabel()),
    onSuccess: onSummary,
  });
  const code = start.data;
  const secondsLeft = useSecondsLeft(code?.expiresAt);
  const expired = code !== undefined && secondsLeft === 0;
  const problem = pairingProblem(typed.error ?? start.error ?? wait.error, false);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Copy from another device</DialogTitle>
        <DialogDescription>
          On your iPhone or iPad, open Settings › Integrations › Add to another device, tap Scan a
          Mac’s code, and point it at this code. Both need the same Wi-Fi.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-5">
        {code ? (
          <ShowCode code={code} expired={expired} secondsLeft={secondsLeft} sending={false} />
        ) : (
          !start.error && <Spinner className="mx-auto size-6 text-muted-foreground" />
        )}
        {phraseAvailable && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              typed.mutate();
            }}
          >
            <label htmlFor="pair-phrase" className="text-small text-muted-foreground">
              Copying from another Mac? Type the six words it shows.
            </label>
            <div className="flex gap-2">
              <Input
                id="pair-phrase"
                value={phrase}
                onChange={(event) => setPhrase(event.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="six words"
              />
              <Button
                type="submit"
                variant="outline"
                disabled={phrase.trim().split(/\s+/).length < 6}
                loading={typed.isPending}
              >
                Copy
              </Button>
            </div>
          </form>
        )}
        {problem && <ProblemAlert problem={problem} />}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
        {(expired || start.error || wait.error) && (
          <Button type="button" loading={start.isPending} onClick={() => start.mutate()}>
            <RefreshCw />
            New code
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

// What arrived, matched to this device's profiles: confirm before keeping.
function ConfirmCopy({ summary, onDone }: { summary: Summary; onDone: () => void }) {
  const queryClient = useQueryClient();
  const sent = summary.profiles ?? [];
  const [targets, setTargets] = useState<Record<number, number>>(() =>
    Object.fromEntries(sent.map((p) => [p.index, p.target])),
  );
  const [tmdb, setTmdb] = useState(summary.tmdbKey);
  const clash = useMemo(() => {
    const chosen = Object.values(targets).filter((t) => t !== 0);
    return new Set(chosen).size !== chosen.length;
  }, [targets]);
  const anything = Object.values(targets).some((t) => t !== 0) || tmdb;
  const confirm = useMutation({
    mutationFn: () =>
      Pairing.Confirm({
        targets: Object.fromEntries(Object.entries(targets).filter(([, t]) => t !== 0)),
        tmdbKey: tmdb,
      }),
    onSuccess: (applied) => {
      void queryClient.invalidateQueries({ queryKey: ["tracking"] });
      void queryClient.invalidateQueries({ queryKey: ["secrets"] });
      toastManager.add({ type: "success", title: appliedMessage(applied) });
      onDone();
    },
  });
  const problem = pairingProblem(confirm.error, false);
  const from = summary.sender.deviceName || "your other device";

  return (
    <>
      <DialogHeader>
        <DialogTitle>Copy from {from}?</DialogTitle>
        <DialogDescription>
          Choose where each profile’s connections go. Kids profiles are never copied.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4">
        {sent.map((p) => {
          const target = targets[p.index] ?? 0;
          const choice = (p.choices ?? []).find((c) => c.profileId === target);
          const replaces = [
            choice?.simkl && p.simklUser && "SIMKL",
            choice?.anilist && p.anilistUser && "AniList",
          ].filter(Boolean);
          const id = `pair-target-${p.index}`;
          return (
            <div key={p.index} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p id={`${id}-label`} className="font-medium">
                    {p.name}
                  </p>
                  <p className="text-small text-muted-foreground">{profileServices(p)}</p>
                </div>
                <ResponsiveSelect
                  items={[
                    ...(p.choices ?? []).map((c) => ({
                      value: String(c.profileId),
                      label: c.name,
                    })),
                    { value: "0", label: "Skip" },
                  ]}
                  value={String(target)}
                  onValueChange={(next) =>
                    next !== null && setTargets({ ...targets, [p.index]: Number(next) })
                  }
                  title={`Where ${p.name} goes`}
                  aria-labelledby={`${id}-label`}
                  className="w-36"
                />
              </div>
              {replaces.length > 0 && (
                <p className="text-small text-muted-foreground">
                  Replaces {choice?.name}’s {replaces.join(" and ")} connection here.
                </p>
              )}
            </div>
          );
        })}
        {summary.tmdbKey && (
          <ChoiceRow
            id="pair-take-tmdb"
            label="TMDB key"
            description={
              summary.replacesTmdbKey
                ? "Replaces the key on this device."
                : "For logos, backdrops and cast photos."
            }
            checked={tmdb}
            onChange={setTmdb}
          />
        )}
        {clash && (
          <p className="text-small text-destructive-foreground">
            Two profiles are going to the same profile here. Pick another, or skip one.
          </p>
        )}
        {problem && <ProblemAlert problem={problem} />}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
        <Button
          type="button"
          disabled={clash || !anything}
          loading={confirm.isPending}
          onClick={() => confirm.mutate()}
        >
          Copy
        </Button>
      </DialogFooter>
    </>
  );
}
