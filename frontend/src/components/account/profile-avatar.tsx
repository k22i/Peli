import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { contrastRatio } from "@/lib/contrast";
import { initials, type Profile } from "@/lib/profile";
import { cn } from "@/lib/utils";

const ink = "#0A0A0A";
const paper = "#FFFFFF";

// Black or white initials, whichever reads better on a profile's colour.
export function initialsColor(background: string): string {
  return contrastRatio(ink, background) >= contrastRatio(paper, background) ? ink : paper;
}

// Go saves only "#rrggbb", but the colour is styled inline, so check again.
const hexColor = /^#[\da-f]{6}$/i;

type ProfileAvatarProps = {
  profile: Pick<Profile, "name" | "avatar" | "avatarColor">;
  className?: string;
};

// A profile's Nuvio avatar on its colour (#24). Until the image loads, or if
// it can't (offline, or no avatar), its initials show instead: on its colour,
// or on the lagoon brand for a profile without one, such as the Guest.
export function ProfileAvatar({ profile, className }: ProfileAvatarProps) {
  const color =
    profile.avatarColor && hexColor.test(profile.avatarColor) ? profile.avatarColor : undefined;
  return (
    // Always shown beside the name, so screen readers skip it.
    <Avatar
      aria-hidden
      className={cn(!color && "bg-brand text-brand-foreground", className)}
      style={color ? { backgroundColor: color, color: initialsColor(color) } : undefined}
    >
      {profile.avatar && <AvatarImage src={profile.avatar} alt="" draggable={false} />}
      {/* Briefly held back while an image loads, so it doesn't flash. */}
      <AvatarFallback className="bg-transparent" delay={profile.avatar ? 400 : 0}>
        {initials(profile.name)}
      </AvatarFallback>
    </Avatar>
  );
}
