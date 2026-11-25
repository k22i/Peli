// Settings › Live TV (W8: TODO).
export function LiveTVPane({
  title,
  profileId,
}: {
  title: string;
  profileId?: number | undefined;
}) {
  return title && profileId ? null : null;
}
