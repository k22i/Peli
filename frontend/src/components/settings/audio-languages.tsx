import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { SettingRow } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { ResponsiveSelect } from "@/components/ui/responsive-select";
import {
  addLanguage,
  audioLanguageLimit,
  languageName,
  languages,
  moveLanguage,
  removeLanguage,
} from "@/lib/settings";

const addId = "audio-languages-add";

// The profile's audio languages, most preferred first (#98): a row to add one,
// and the list under it with each language's move and remove buttons. Plain
// buttons rather than dragging, so the order is reachable from the keyboard;
// the first and last can't move past the ends, which is announced rather than
// disabled so focus stays where the user left it.
export function AudioLanguagesRow({
  value,
  onChange,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const [announcement, setAnnouncement] = useState("");
  const full = value.length >= audioLanguageLimit;
  const items = [
    { value: "", label: "Add a language" },
    ...languages
      .filter((code) => !value.includes(code))
      .map((code) => ({ value: code, label: languageName(code) }))
      .toSorted((a, b) => a.label.localeCompare(b.label)),
  ];

  const move = (code: string, by: -1 | 1) => {
    const next = moveLanguage(value, code, by);
    if (next.join() === value.join()) return;
    onChange(next);
    setAnnouncement(`${languageName(code)} is number ${next.indexOf(code) + 1} of ${next.length}`);
  };
  const remove = (code: string) => {
    onChange(removeLanguage(value, code));
    setAnnouncement(`${languageName(code)} removed`);
    // The buttons that held focus are gone: the add control is the next stop.
    document.getElementById(addId)?.focus();
  };

  return (
    <>
      <SettingRow
        id="audio-languages"
        label="Audio languages"
        description="Streams in the first language rank highest, then the next. Playback starts with the first one the video has. With none, the original audio plays."
      >
        <ResponsiveSelect
          items={items}
          value=""
          disabled={full}
          onValueChange={(next) => {
            if (!next) return;
            onChange(addLanguage(value, next));
            setAnnouncement(`${languageName(next)} added, number ${value.length + 1}`);
          }}

          id={addId}
          aria-labelledby="audio-languages-label"
          aria-describedby="audio-languages-description"
          className="w-44"
        />
      </SettingRow>
      {value.length > 0 && (
        <ol aria-label="Audio languages, most preferred first" className="flex flex-col divide-y">
          {value.map((code, index) => {
            const name = languageName(code);
            return (
              <li key={code} className="flex items-center gap-3 px-4 py-2">
                <span aria-hidden className="w-5 text-small text-muted-foreground tabular-nums">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate type-item">{name}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${name} earlier`}
                  aria-disabled={index === 0}
                  className="aria-disabled:opacity-40"
                  onClick={() => move(code, -1)}
                >
                  <ChevronUpIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${name} later`}
                  aria-disabled={index === value.length - 1}
                  className="aria-disabled:opacity-40"
                  onClick={() => move(code, 1)}
                >
                  <ChevronDownIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${name}`}
                  onClick={() => remove(code)}
                >
                  <XIcon />
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      <output className="sr-only">{announcement}</output>
    </>
  );
}
