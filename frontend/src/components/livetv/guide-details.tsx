import { Badge } from "@/components/ui/badge";
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
import { clockLabel, type Channel, type Programme } from "@/lib/livetv";

// What a click on a guide block that isn't on now opens (W6): the programme's
// times, its episode, what it's about, its categories and its still. A
// finished programme reads the same way as one still to come.
export function GuideDetails({
  programme,
  channel,
  onClose,
}: {
  // undefined: closed.
  programme: Programme | undefined;
  channel: Channel | undefined;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={programme !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup sheet className="sm:max-w-md">
        {programme && channel ? <Details programme={programme} channel={channel} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function Details({ programme, channel }: { programme: Programme; channel: Channel }) {
  // The day it airs, as the reader's locale writes it: "Tue".
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(programme.start);
  const line = [programme.episode, programme.subTitle].filter(Boolean).join(" · ");
  // Go's list fields reach the frontend as nullable.
  const categories = programme.categories ?? [];
  return (
    <>
      <DialogHeader>
        <DialogTitle>{programme.title}</DialogTitle>
        <DialogDescription>
          {channel.name} · {weekday} {clockLabel(programme.start)}–{clockLabel(programme.stop)}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-3 text-sm">
        {line ? <p className="font-medium">{line}</p> : null}
        {programme.description ? (
          <p className="text-muted-foreground">{programme.description}</p>
        ) : null}
        {categories.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {categories.map((category) => (
              <Badge key={category} variant="outline" size="sm">
                {category}
              </Badge>
            ))}
          </div>
        ) : null}
        {programme.icon ? (
          <img alt="" src={programme.icon} className="max-h-40 rounded-lg" />
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
      </DialogFooter>
    </>
  );
}
