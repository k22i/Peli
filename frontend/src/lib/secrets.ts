import { Service as Secrets } from "@bindings/secrets";

// Tokens and keys live in the OS keychain, through the Go secrets service
// (#15). Hold what you read in memory only: never write it to localStorage,
// and never put it in a query marked meta.persist (shouldPersistQuery refuses
// the "secrets" key anyway).
export type SecretKey =
  | "nuvio.access-token"
  | "nuvio.refresh-token"
  | "trakt.access-token"
  | "trakt.refresh-token"
  | "tmdb.api-key"
  | `debrid.${string}`;

export const secrets = {
  get: (key: SecretKey) => Secrets.Get(key),
  set: (key: SecretKey, value: string) => Secrets.Set(key, value),
  delete: (key: SecretKey) => Secrets.Delete(key),
  // Rejects with what to install when there's no keychain (Linux without a
  // Secret Service).
  available: () => Secrets.Available(),
};
