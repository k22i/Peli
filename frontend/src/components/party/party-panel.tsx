import { Check, Copy, LogOut, PartyPopper, Power } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";

import { Artwork } from "@/components/media/artwork";
import { PartyMembers } from "@/components/party/party-members";
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
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import {
  codeLength,
  errorCode,
  formatCode,
  inviteText,
  mediaLabel,
  normalizeCode,
  Party,
  partyProblem,
  usePartyActions,
  type PartyInfo,
  type Preview,
} from "@/lib/party";
import { cn } from "@/lib/utils";

const fail = (title: string) => (error: unknown) =>
  toastManager.add({ type: "error", title, description: partyProblem(errorCode(error)) });

// The party this device is in: its code to share, who's in it, the host's
// controls, and leaving (or, for the host, ending it for everyone).
export function PartyPanel({
  party,
  canShare,
}: {
  party: PartyInfo;
  // Whether the host's stream is one others could open (not a torrent).
  canShare?: boolean;
}) {
  const { leave, end } = usePartyActions();
  const [ending, setEnding] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <InviteCode code={party.code} />
      <PartyMembers
        members={party.members ?? []}
        maxMembers={party.maxMembers}
        isHost={party.isHost}
      />
      {party.isHost ? (
        <section
          aria-label="Host controls"
          className="flex flex-col gap-1 rounded-2xl bg-foreground/5 p-1"
        >
          <SwitchRow
            label="Only I can control playback"
            description="Others can still pause or go back for themselves."
            checked={party.hostOnly}
            onChange={(on) =>
              void Party.SetHostOnly(on).catch(fail("Couldn’t change who controls playback"))
            }
          />
          <SwitchRow
            label="Share my stream"
            description={
              canShare === false
                ? "This stream can’t be shared: it plays from this device."
                : "Friends can play your link instead of picking their own. It can carry your debrid key."
            }
            checked={party.sharing}
            disabled={canShare === false && !party.sharing}
            onChange={(on) => void Party.SetSharing(on).catch(fail("Couldn’t share the stream"))}
          />
        </section>
      ) : (
        party.hostOnly && (
          <p className="rounded-xl bg-foreground/5 px-3 py-2 text-small text-muted-foreground">
            Only the host can control playback. You can still pause or go back for yourself.
          </p>
        )
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          className="pointer-coarse:min-h-11"
          onClick={() => void leave()}
        >
          <LogOut />
          Leave party
        </Button>
        {party.isHost && (
          <Button
            variant="destructive-outline"
            className="pointer-coarse:min-h-11"
            onClick={() => setEnding(true)}
          >
            <Power />
            End for everyone
          </Button>
        )}
      </div>
      <p className="text-small text-muted-foreground">
        Watch parties are new in Nuvio and may not always keep perfect time.
      </p>
      <AlertDialog open={ending} onOpenChange={setEnding}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>End the watch party?</AlertDialogTitle>
            <AlertDialogDescription>Everyone will be disconnected from it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setEnding(false);
                void end().catch(fail("Couldn’t end the watch party"));
              }}
            >
              End party
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function InviteCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    // On a phone the code and its button stack, so neither squeezes (ADR-0063).
    <div className="flex items-center justify-between gap-4 rounded-2xl bg-foreground/5 p-4 ios-compact:flex-col ios-compact:items-stretch">
      <div className="flex flex-col gap-1">
        <p className="type-eyebrow text-muted-foreground">Party code</p>
        <p
          aria-label={`Party code ${code.split("").join(" ")}`}
          className="font-mono text-[1.75rem] leading-none font-[650] tracking-[0.12em]"
        >
          {formatCode(code)}
        </p>
      </div>
      <Button
        variant="secondary"
        className="pointer-coarse:min-h-11"
        onClick={() =>
          void navigator.clipboard.writeText(inviteText(code)).then(
            () => setCopied(true),
            () => toastManager.add({ type: "error", title: "Couldn’t copy the invite" }),
          )
        }
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy invite"}
      </Button>
    </div>
  );
}

function SwitchRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <div
      className={cn(
        "flex items-center gap-4 rounded-xl px-3 py-2.5 hover:bg-foreground/4",
        disabled && "opacity-60",
      )}
    >
      <label
        htmlFor={id}
        className={cn(
          "flex min-w-0 flex-1 flex-col",
          disabled ? "cursor-not-allowed" : "cursor-pointer",
        )}
      >
        <span className="text-body font-[590]">{label}</span>
        <span className="text-small text-muted-foreground">{description}</span>
      </label>
      <Switch id={id} checked={checked} disabled={disabled ?? false} onCheckedChange={onChange} />
    </div>
  );
}

// Joining with a friend's code: as six characters are typed, what the code
// joins shows (the title, the host, the seats), and Join joins it.
export function JoinParty({ onJoined }: { onJoined?: () => void }) {
  const { join } = usePartyActions();
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<{ code: string; preview: Preview }>();
  const [joining, setJoining] = useState(false);
  const [problem, setProblem] = useState<string>();
  const clean = normalizeCode(code);
  const complete = clean.length === codeLength;

  useEffect(() => {
    if (!complete) return undefined;
    let live = true;
    Party.Preview(clean).then(
      (answer) => live && setPreview({ code: clean, preview: answer }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [clean, complete]);
  const shown = complete && preview?.code === clean ? preview.preview : undefined;
  const full = shown !== undefined && shown.maxMembers > 0 && shown.members >= shown.maxMembers;
  const refusal = shown?.error
    ? partyProblem(shown.error)
    : full
      ? partyProblem("party_full")
      : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!complete || joining) return;
    setJoining(true);
    setProblem(undefined);
    join(clean).then(
      () => onJoined?.(),
      (error: unknown) => {
        setJoining(false);
        setProblem(partyProblem(errorCode(error)));
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-2">
        <span className="text-body text-muted-foreground">
          Enter the 6-character code your friend shared.
        </span>
        <input
          aria-label="Party code"
          value={formatCode(code)}
          onChange={(event) => {
            setProblem(undefined);
            setCode(normalizeCode(event.target.value).slice(0, codeLength));
          }}
          onKeyDown={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
          autoComplete="off"
          spellCheck={false}
          placeholder="ABC DEF"
          // A field's own width is its 20-character default, which on a phone
          // is wider than the screen: fill the column, and let it shrink.
          className="h-14 w-full min-w-0 rounded-2xl bg-foreground/6 px-5 text-center font-mono text-[1.625rem] font-[650] tracking-[0.18em] uppercase outline-none placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      {complete && !shown && (
        <p className="flex items-center gap-2 text-small text-muted-foreground">
          <Spinner className="size-3.5" />
          Looking for the party…
        </p>
      )}
      {shown?.media && !refusal && (
        <div className="flex items-center gap-3 rounded-2xl bg-foreground/5 p-3">
          {shown.media.poster ? (
            <Artwork
              src={shown.media.poster}
              use="poster"
              title={shown.media.title}
              className="aspect-[2/3] w-12 shrink-0 rounded-lg"
            />
          ) : (
            <span className="grid aspect-[2/3] w-12 shrink-0 place-items-center rounded-lg bg-foreground/8">
              <PartyPopper aria-hidden className="size-5 text-muted-foreground" />
            </span>
          )}
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="truncate text-body font-[590]">{mediaLabel(shown.media)}</p>
            <p className="truncate text-small text-muted-foreground">
              {shown.host ? `Hosted by ${shown.host} · ` : ""}
              <span className="tnum">
                {shown.members} of {shown.maxMembers} seats
              </span>
            </p>
          </div>
        </div>
      )}
      {(problem ?? refusal) && (
        <p role="alert" className="text-small text-destructive-foreground">
          {problem ?? refusal}
        </p>
      )}
      <Button
        type="submit"
        size="lg"
        className="pointer-coarse:min-h-11"
        disabled={!complete || joining || refusal !== undefined}
      >
        {joining && <Spinner />}
        Join
      </Button>
    </form>
  );
}
