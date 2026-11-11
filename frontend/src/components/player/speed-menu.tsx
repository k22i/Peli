import {
  PlayerMenu,
  PlayerMenuRadioGroup,
  PlayerMenuRadioItem,
} from "@/components/player/player-menu";
import { normalSpeed, sameSpeed, speedLabel, speeds } from "@/lib/speed";

// The dock's Speed menu: the speed as the trigger's text, the steps to pick
// from ([ and ] move through them, Backspace goes back to 1×).
export function SpeedMenu({
  speed,
  onChange,
  open,
  onOpenChange,
}: {
  speed: number;
  onChange: (speed: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const picked = speeds.find((each) => sameSpeed(each, speed)) ?? speed;
  return (
    <PlayerMenu
      label={`Playback speed, ${speedLabel(speed)}`}
      shortcut="[ ] Backspace"
      open={open}
      onOpenChange={onOpenChange}
      triggerClassName="px-2.5"
      trigger={
        <span className="text-small font-[650] tnum">
          {speedLabel(sameSpeed(speed, normalSpeed) ? normalSpeed : speed)}
        </span>
      }
    >
      <PlayerMenuRadioGroup label="Playback speed" value={picked} onChange={onChange}>
        {speeds.toReversed().map((each) => (
          <PlayerMenuRadioItem
            key={each}
            value={each}
            hint={each === normalSpeed ? "Normal" : undefined}
          >
            {speedLabel(each)}
          </PlayerMenuRadioItem>
        ))}
      </PlayerMenuRadioGroup>
    </PlayerMenu>
  );
}
