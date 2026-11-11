import type { Meta } from "@/lib/addon-protocol";
import type { MenuTitle } from "@/lib/title-actions";
import type { Profile } from "@bindings/store";

// The slot at the end of every title's context menu, for groups that belong
// to one feature rather than to titles in general (a "Tracking" group, say).
// It renders inside the menu popup, after the built-in items, and is mounted
// only while the menu is open, so it may call hooks and run queries.
//
// To add a group, render its own `ContextMenuSeparator` first, then a
// `ContextMenuGroupLabel` and `ContextMenuItem`s from components/ui/
// context-menu. `meta` is the title's details once they've loaded (and
// undefined until then); `profile.kids` is true on a kids profile, which
// must be offered nothing that writes to a tracking service (ADR-0014,
// ADR-0042).
export type TitleMenuExtrasProps = {
  title: MenuTitle;
  meta: Meta | undefined;
  profile: Profile;
};

// Nothing yet.
export function TitleMenuExtras(props: TitleMenuExtrasProps) {
  void props;
  return null;
}
