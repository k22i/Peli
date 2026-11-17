import type { Section } from "@/sections";

// The asset-catalog image a section's tab shows in the native iOS tab bar
// (#129): build/ios/Assets.xcassets/Tab<Label>.imageset, a template SVG of
// the same lucide glyph as the web. tab-icons.test.ts checks every section
// has one, and rewrites them with UPDATE_TAB_ICONS=1.
export function tabIconName(section: Pick<Section, "label">): string {
  return `Tab${section.label.replaceAll(/[^A-Za-z0-9]/g, "")}`;
}
