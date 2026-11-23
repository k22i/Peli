import { Minus, Plus } from "lucide-react";

import {
  Chip,
  ChipGroup,
  Field,
  previewRow,
  RoundStep,
  SectionHead,
  Toggle,
  type Preview,
} from "@/components/player/panel-controls";
import { feature } from "@/lib/features";
import {
  audioDelayStep,
  audioDelayText,
  deviceName,
  equalizerHint,
  equalizerPresets,
  maxAudioDelay,
  type Audio,
  type AudioDevice,
  type Sound,
} from "@/lib/sound";

export type SoundProps = {
  // This title's sound.
  sound: Sound;
  // Whether the title has a sound of its own (Reset has something to do).
  own: boolean;
  onChange: (sound: Sound) => void;
  onReset: () => void;
  // Makes it the profile's.
  onUseForAll: () => void;
  // The sound's delay for this video, in seconds.
  delay: number;
  onDelayChange: (delay: number) => void;
  // This device's output, and the devices there are.
  audio: Audio;
  devices: readonly AudioDevice[];
  onAudioChange: (audio: Audio) => void;
  // Whether the track playing is surround (more than two channels).
  surround: boolean;
};

const roundDelay = (delay: number) =>
  Math.max(-maxAudioDelay, Math.min(maxAudioDelay, Math.round(delay * 100) / 100));

export function SoundTab({
  sound,
  own,
  onChange,
  onReset,
  delay,
  onDelayChange,
  audio,
  devices,
  onAudioChange,
  surround,
  preview,
}: SoundProps & { preview: Preview }) {
  const hidden = previewRow(preview);
  // The phone has the system's own output (no AudioDevices to pick from) and
  // its volume stops at 100 %: those two rows are left out there.
  const output = feature("audioOutput");
  return (
    <div className={`flex flex-col gap-6 px-4 pb-5 ${hidden}`}>
      <section aria-label="Sound" className="flex flex-col gap-5">
        <SectionHead title="Sound" reset={own ? onReset : undefined} />
        <div className="-mx-4 flex flex-col">
          <Toggle
            label="Dialogue boost"
            hint={
              surround
                ? "Lifts speech over music and effects. Surround sound comes out of the front while it's on."
                : "Lifts speech over music and effects."
            }
            checked={sound.dialogueBoost}
            onChange={(dialogueBoost) => onChange({ ...sound, dialogueBoost })}
          />
          <Toggle
            label="Night mode"
            hint="Evens out loud and quiet: explosions come down, whispers come up."
            checked={sound.nightMode}
            onChange={(nightMode) => onChange({ ...sound, nightMode })}
          />
        </div>
        <Field label="Equalizer">
          <ChipGroup label="Equalizer">
            {equalizerPresets.map((preset) => (
              <Chip
                key={preset.id}
                pressed={sound.equalizer === preset.id}
                onClick={() => onChange({ ...sound, equalizer: preset.id })}
              >
                {preset.name}
              </Chip>
            ))}
          </ChipGroup>
          <p className="text-tiny leading-snug text-white/50">
            {equalizerHint[sound.equalizer] ?? ""}
          </p>
        </Field>
      </section>

      <section aria-label="Audio delay" className="flex flex-col gap-3">
        <Field label="Audio delay" value={audioDelayText(delay)}>
          <div className="flex items-center gap-3">
            <RoundStep
              label="Sound earlier"
              disabled={delay <= -maxAudioDelay}
              onClick={() => onDelayChange(roundDelay(delay - audioDelayStep))}
            >
              <Minus />
            </RoundStep>
            <p className="flex-1 text-center text-small text-white/60">
              {delay === 0
                ? "In sync"
                : delay > 0
                  ? "The sound comes later"
                  : "The sound comes earlier"}
            </p>
            <RoundStep
              label="Sound later"
              disabled={delay >= maxAudioDelay}
              onClick={() => onDelayChange(roundDelay(delay + audioDelayStep))}
            >
              <Plus />
            </RoundStep>
          </div>
        </Field>
        <div className="flex items-center justify-between gap-3">
          <p className="text-tiny leading-snug text-white/50">For this video only.</p>
          {delay !== 0 && (
            <button
              type="button"
              onClick={() => onDelayChange(0)}
              className="h-8 rounded-full px-3 text-small font-[560] text-white/75 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-ring"
            >
              Back in sync
            </button>
          )}
        </div>
      </section>

      <section aria-label="This device" className="flex flex-col gap-5">
        <SectionHead title="This device" reset={undefined} />
        {output && devices.length > 1 && (
          <Field label="Output">
            <ChipGroup label="Output">
              {devices.map((device) => (
                <Chip
                  key={device.name}
                  pressed={audio.device === device.name}
                  onClick={() => onAudioChange({ ...audio, device: device.name })}
                >
                  {deviceName(device)}
                </Chip>
              ))}
            </ChipGroup>
          </Field>
        )}
        <div className="-mx-4 flex flex-col">
          <Toggle
            label="Stereo downmix"
            hint="Mixes surround tracks down to two channels, for stereo speakers and headphones."
            checked={audio.stereoDownmix}
            onChange={(stereoDownmix) => onAudioChange({ ...audio, stereoDownmix })}
          />
          {feature("volumeBoost") && (
            <Toggle
              label="Volume up to 150 %"
              hint="For quiet tracks. Above 100 % loud parts can distort."
              checked={audio.volumeBoost}
              onChange={(volumeBoost) => onAudioChange({ ...audio, volumeBoost })}
            />
          )}
        </div>
      </section>
    </div>
  );
}
