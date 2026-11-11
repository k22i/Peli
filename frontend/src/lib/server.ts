import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";

import { Service as Account, type Server } from "@bindings/account";

// The backend Peli signs in to (#34): Nuvio's, or the user's own
// Nuvio-compatible server, such as a self-hosted one. Go keeps the URL in the
// store and the key, if any, in the keychain; the key never comes back here.
export const serverQuery = queryOptions({
  queryKey: ["server"],
  queryFn: () => Account.Server(),
  staleTime: Number.POSITIVE_INFINITY,
});

// The address to show for a server: its host, and its path if it has one.
export function serverName(url: string): string {
  try {
    const { host, pathname } = new URL(url);
    return pathname === "/" ? host : host + pathname;
  } catch {
    return url;
  }
}

// What the user typed for their own server. An empty url is Nuvio's server.
export type ServerInput = { url: string; key: string };

// Checks that a server answers as a Nuvio backend and takes the key, without
// switching to it.
export function useTestServer() {
  return useMutation({
    mutationFn: ({ url, key }: ServerInput) => Account.TestServer(url, key),
  });
}

// Switches server. Go checks it first; switching to another server signs out
// and removes the account's profiles and the cache, as signing out does, so
// the in-memory cache goes too.
export function useSetServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ url, key }: ServerInput) => Account.SetServer(url, key),
    onSuccess: (server: Server) => {
      const before = queryClient.getQueryData(serverQuery.queryKey);
      if (before?.url !== server.url) queryClient.clear();
      queryClient.setQueryData(serverQuery.queryKey, server);
    },
  });
}

// The codes internal/account gives a failed server check or switch.
const serverErrorCodes = [
  "invalid_server_url",
  "invalid_server_key",
  "not_nuvio_server",
  "server_key_refused",
  "unreachable",
  "unavailable",
  "rate_limited",
  "keychain_unavailable",
  "parent_pin_required",
] as const;

export type ServerProblem = {
  // The field it belongs under, if one.
  field?: "url" | "key";
  title: string;
  description: string;
};

// What to tell the user when a server check or switch fails.
export function serverProblem(error: Error): ServerProblem {
  const cause: unknown = error.cause;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? serverErrorCodes.find((c) => c === cause.code)
      : undefined;
  switch (code) {
    case "invalid_server_url":
      return {
        field: "url",
        title: "That isn’t a server address",
        description: "Enter the full address, starting with https:// or http://.",
      };
    case "invalid_server_key":
      return {
        field: "key",
        title: "That isn’t a key",
        description: "A key has no spaces. Paste it again from your server’s settings.",
      };
    case "server_key_refused":
      return {
        field: "key",
        title: "The server refused the key",
        description: "Use the server’s publishable (anon) key, or leave it empty.",
      };
    case "not_nuvio_server":
      return {
        title: "That isn’t a Nuvio server",
        description:
          "It answered, but not as a Nuvio backend. Check the address. If the server doesn’t publish its key, enter it.",
      };
    case "unreachable":
      return {
        title: "Can’t reach the server",
        description: "Check the address and your connection, and that the server is running.",
      };
    case "unavailable":
    case "rate_limited":
      return {
        title: "The server isn’t answering",
        description: "It returned an error. Try again in a minute.",
      };
    case "keychain_unavailable":
      return { title: "A key needs a keychain", description: error.message };
    case "parent_pin_required":
      return {
        title: "A kids profile is in use",
        description: "The parent PIN is needed to switch servers.",
      };
    default:
      return { title: "Couldn’t switch server", description: error.message };
  }
}
