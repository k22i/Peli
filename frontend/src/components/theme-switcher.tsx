import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  setThemePreference,
  themePreferences,
  useThemePreference,
  type ThemePreference,
} from "@/lib/theme";

const options = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
] as const satisfies readonly { value: ThemePreference; label: string; icon: LucideIcon }[];

// System, Light or Dark: the manual override for the OS appearance.
export function ThemeSwitcher() {
  const preference = useThemePreference();

  return (
    <ToggleGroup
      aria-label="Appearance"
      variant="outline"
      value={[preference]}
      onValueChange={([pressed]) => {
        // Pressing the current option would clear the group; keep it.
        const next = themePreferences.find((option) => option === pressed);
        if (next) setThemePreference(next);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} className="gap-1.5 px-3">
          <option.icon aria-hidden />
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
