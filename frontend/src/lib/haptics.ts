// Haptic feedback on iOS. A no-op for now: #135 fills it in, behind a bound
// Go service with a desktop no-op twin (epic #126 decisions). Call sites:
// - "light" when a long press opens a bottom sheet (components/ui/
//   responsive-menu.tsx, #134).
export type HapticKind = "light" | "medium" | "selection" | "success" | "warning";

export function haptic(_kind: HapticKind): void {
  // #135
}
