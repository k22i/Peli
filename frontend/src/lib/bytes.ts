// Sizes for the screens: "940 KB", "3.4 MB", "1.2 GB". Decimal units, as
// disks and speeds count. Here rather than in lib/torrent so that downloads
// (#85, ADR-0064) show sizes without the torrent bindings; lib/torrent
// re-exports it for the screens that already ask there.
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit > 1 && value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}
