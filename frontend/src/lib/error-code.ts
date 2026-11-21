// The code a Go service's MarshalError put in a call's cause (party, downloads).
export function errorCode(error: unknown): string | undefined {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  return typeof code === "string" ? code : undefined;
}
