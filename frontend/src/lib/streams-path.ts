// The stream picker's address (#50), and the search it keeps there: the
// title, with the video and resume point in its search, and the target in
// history state for its heading.
//
// Its own module, small as it is, because lib/party.ts builds that address
// too (the party's picker, and a guest's way in) and lib/playback.ts now asks
// lib/party.ts who is a guest: one of the two has to import the other
// without the import coming back, so the address lives here instead.
export const streamsPath = "/streams/$type/$id";

export type StreamsSearch = { video?: string; at?: number };

export function streamsSearch(search: Record<string, unknown>): StreamsSearch {
  const video = search["video"];
  const at = search["at"];
  return {
    ...(typeof video === "string" && video ? { video } : {}),
    ...(typeof at === "number" && Number.isFinite(at) && at > 0 ? { at } : {}),
  };
}
