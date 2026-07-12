/**
 * The second half of reuse's double opt-in (see `GenericContainer.withReuse`
 * for the first half, the API marker): exactly `"true"` or `"1"`, matching
 * the feature spec's own wording. Any other value — including a
 * near-miss like `"True"` or `"yes"` — is treated as disabled, the same
 * strict-match convention as the rest of this library's boolean-shaped env
 * vars (unlike `RIGHTSIZE_REAPER`, whose unrecognized values fall back to
 * its safe default rather than "off": reuse's safe default IS off, so an
 * unrecognized value staying off needs no special-casing here at all).
 */
export function reuseEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env["RIGHTSIZE_REUSE"];
  return raw === "true" || raw === "1";
}
