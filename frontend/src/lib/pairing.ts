// Device pairing (#133, ADR-0061): copying SIMKL, AniList and the TMDB key
// to another device over the local network. Go holds every token; the
// webview only sees names, which services, and the QR code to draw.
//
// The camera always scans: a phone or tablet scans a code, a Mac shows one.
// A Mac sending to another Mac also shows a six-word phrase.

import { Service as Pairing } from "@bindings/pairing";
import type { Applied, ProfileMatch } from "@bindings/pairing";
import { Service as Shell } from "@bindings/shell";

import { deviceName, isIOS } from "@/lib/platform";

export { Pairing, Shell };

// What every pairing code starts with; the scanner ignores other codes.
export const pairingCodePrefix = "peli-pair:v1:";

// The name Go gives this device on iOS ("iPhone" or "iPad"); a Mac uses its
// computer name.
export function pairingLabel(): string {
  return deviceName();
}

const codes = [
  "wrong_account",
  "not_signed_in",
  "expired",
  "used",
  "too_many_tries",
  "refused",
  "local_network",
  "unreachable",
  "no_network",
  "no_sender",
  "nothing_to_send",
  "bad_code",
  "bad_phrase",
  "wrong_way",
  "bad_bundle",
  "cancelled",
  "nothing_held",
  "kids_profile",
  // From the scanner (shell).
  "no_scanner",
  "camera_denied",
] as const;

export type PairingErrorCode = (typeof codes)[number];

export function pairingErrorCode(error: unknown): PairingErrorCode | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause: unknown = error.cause;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  return codes.find((code) => code === cause.code);
}

export type PairingProblem = {
  title: string;
  description?: string | undefined;
  // Offer a button to Peli's page in the Settings app (iOS).
  settings?: boolean;
};

// What to say when pairing fails. sending is the side with the
// connections, for the "wrong way" message.
export function pairingProblem(error: unknown, sending: boolean): PairingProblem | undefined {
  switch (pairingErrorCode(error)) {
    case "cancelled":
      return undefined;
    case "wrong_account":
      return {
        title: "Sign in to the same Nuvio account on both devices",
        description: "Profiles are matched through your Nuvio account.",
      };
    case "not_signed_in":
      return {
        title: "Sign in to Nuvio first",
        description: "Profiles are matched through your Nuvio account.",
      };
    case "expired":
      return { title: "The code expired", description: "Show a new one on the other device." };
    case "used":
      return {
        title: "This code was already used",
        description: "A code works once. Show a new one on the other device.",
      };
    case "too_many_tries":
      return { title: "Too many wrong tries", description: "Show a new code on the other device." };
    case "refused":
      return {
        title: "The other device didn’t accept the code",
        description: "Check the words, or show a new code on the other device.",
      };
    case "local_network":
      return {
        title: "Peli can’t reach your other device",
        description:
          "Turn on Local Network for Peli in Settings, and check both are on the same Wi-Fi.",
        settings: true,
      };
    case "unreachable":
      return {
        title: "Peli can’t reach your other device",
        description: isIOS()
          ? "Check both are on the same Wi-Fi, and that Local Network is on for Peli in Settings. Some networks keep devices apart: try your home Wi-Fi."
          : "Check both are on the same Wi-Fi. Some networks keep devices apart: try your home Wi-Fi.",
        settings: isIOS(),
      };
    case "no_network":
      return {
        title: "Not on a Wi-Fi network",
        description: "Connect both devices to the same Wi-Fi.",
      };
    case "no_sender":
      return {
        title: "No Mac is showing that phrase",
        description:
          "Check the words, and that the other Mac is on this Wi-Fi with its code still showing.",
      };
    case "nothing_to_send":
      return {
        title: "Nothing to send",
        description: "Connect SIMKL or AniList on a profile here first, or include the TMDB key.",
      };
    case "bad_code":
      return { title: "That isn’t a Peli pairing code" };
    case "bad_phrase":
      return {
        title: "That isn’t a pairing phrase",
        description: "It’s the six words the other Mac shows.",
      };
    case "wrong_way":
      return sending
        ? {
            title: "That device is offering its connections",
            description: "To copy them here, choose Copy from another device instead.",
          }
        : {
            title: "That device is waiting to receive",
            description: "To send to it, choose Add to another device here instead.",
          };
    case "bad_bundle":
      return {
        title: "The other device sent something Peli can’t read",
        description: "Update Peli on both devices.",
      };
    case "kids_profile":
      return { title: "Kids profiles don’t connect to trackers" };
    case "camera_denied":
      return {
        title: "Camera access is off for Peli",
        description: "Turn it on in Settings to scan the code.",
        settings: true,
      };
    case "no_scanner":
      return { title: "This device has no camera to scan with" };
    case "nothing_held":
      return { title: "Nothing was received", description: "Start again." };
    default:
      return {
        title: "Couldn’t pair",
        description: error instanceof Error ? error.message : undefined,
      };
  }
}

// "SIMKL and AniList", "SIMKL", "AniList", or "".
function services(simkl: boolean, anilist: boolean) {
  return [simkl && "SIMKL", anilist && "AniList"].filter(Boolean).join(" and ");
}

// The toast after keeping: "Connected SIMKL and AniList from Kevin's Mac".
export function appliedMessage(applied: Applied): string {
  const from = applied.sender.deviceName || "your other device";
  const what = services(applied.simkl, applied.anilist);
  if (what && applied.tmdbKey) return `Connected ${what} and the TMDB key from ${from}`;
  if (what) return `Connected ${what} from ${from}`;
  if (applied.tmdbKey) return `Added the TMDB key from ${from}`;
  return `Nothing was kept from ${from}`;
}

// One summary line for a sent profile: "SIMKL (kevin) and AniList (kev)".
export function profileServices(p: ProfileMatch) {
  return [p.simklUser && `SIMKL (${p.simklUser})`, p.anilistUser && `AniList (${p.anilistUser})`]
    .filter(Boolean)
    .join(" and ");
}

// The QR code's modules as an SVG image, black on transparent (as the
// sign-in QR draws it).
export function qrImage(size: number, path: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path d="${path}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
