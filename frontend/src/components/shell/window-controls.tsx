import { Events, Window } from "@wailsio/runtime";
import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState, type ComponentProps } from "react";

import { cn } from "@/lib/utils";

// Minimise, maximise and close for the frameless Windows window. macOS keeps
// its native traffic lights and Linux its native frame.
export function WindowControls() {
  const maximised = useMaximised();

  return (
    <div className="flex h-full self-stretch">
      <ControlButton label="Minimise" onClick={() => void Window.Minimise()}>
        <Minus />
      </ControlButton>
      <ControlButton
        label={maximised ? "Restore" : "Maximise"}
        onClick={() => void Window.ToggleMaximise()}
      >
        {maximised ? <Copy className="-scale-x-100" /> : <Square />}
      </ControlButton>
      <ControlButton
        label="Close"
        className="hover:bg-[#c42b1c] hover:text-white"
        onClick={() => void Window.Close()}
      >
        <X />
      </ControlButton>
    </div>
  );
}

function ControlButton({
  label,
  className,
  ...props
}: ComponentProps<"button"> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // Out of the tab order like native caption buttons: the keyboard has
      // Alt+Space and Alt+F4.
      tabIndex={-1}
      className={cn(
        "grid w-11.5 place-items-center text-foreground/80 hover:bg-accent [&_svg]:size-3.5 [&_svg]:stroke-[1.5]",
        className,
      )}
      {...props}
    />
  );
}

function useMaximised() {
  const [maximised, setMaximised] = useState(false);

  useEffect(() => {
    let live = true;
    const sync = () => {
      void Window.IsMaximised().then((value) => {
        if (live) setMaximised(value);
      });
    };
    sync();
    const off = [
      Events.On(Events.Types.Common.WindowMaximise, sync),
      Events.On(Events.Types.Common.WindowUnMaximise, sync),
      Events.On(Events.Types.Common.WindowRestore, sync),
    ];
    return () => {
      live = false;
      for (const unsubscribe of off) unsubscribe();
    };
  }, []);

  return maximised;
}
