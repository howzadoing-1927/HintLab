import { Llms } from "@cline/sdk";

/**
 * The single friendly message shown/logged when the tutor model cannot be
 * authenticated. It is the one place this wording lives, so the server log,
 * the SSE error event and the web UI all stay identical.
 */
export const AUTH_FAILURE_MESSAGE = "Tutor not connected: run `cline auth` (see README)";

/**
 * Machine-readable code carried on the SSE error event so the UI (and the
 * check script) can recognise an auth failure without string-matching prose.
 */
export const AUTH_FAILURE_CODE = "auth";

/**
 * Error-message heuristics for the auth failures that `classifyProviderError`
 * cannot see (no 401/403 status is present yet) — e.g. the SDK throwing
 * "Provider \"anthropic\" is missing credentials" before it makes a request,
 * or a flattened "invalid/expired api key / token" text.
 */
const AUTH_MESSAGE_PATTERNS: readonly RegExp[] = [
  // "missing credentials", "no api key", "api key is not set", …
  /(?:missing|no|not\s+(?:configured|set|provided|found|available)|requires?)\s+(?:api\s*key|credentials?|auth(?:entication)?\s*(?:token)?|token)\b/i,
  // "invalid api key", "expired token", "revoked credentials", "unauthorized …"
  /(?:invalid|expired|revoked|unauthorized|unauthenticated|forbidden)\s+(?:api\s*key|credentials?|auth(?:entication)?|token|grant)\b/i,
  // "api key is invalid/expired/missing/…"
  /(?:api\s*key|credentials?|token)\s+(?:is\s+)?(?:invalid|expired|revoked|unauthorized|missing|required|not\s+(?:set|configured|provided|found))\b/i,
  // "unauthorized" / "unauthenticated" / "forbidden" on its own, plus raw 401/403
  /\b(?:unauthorized|unauthenticated|forbidden)\b/i,
  /\b(?:401|403)\b/,
  // "authentication failed/error/required", "could not authenticate"
  /authentication\s+(?:failed|error|required)/i,
  /could\s+not\s+authenticate/i,
];

/** True when the SDK-reported `errorClass` field (anywhere) is `"auth"`. */
function hasAuthErrorClass(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const o = err as Record<string, unknown>;
  if (o.errorClass === "auth") return true;
  for (const key of ["error", "cause"]) {
    const v = o[key];
    if (v && typeof v === "object" && hasAuthErrorClass(v)) return true;
  }
  return false;
}

/** Collect the human-readable strings reachable from an error object. */
function collectMessages(err: unknown, out: string[], depth: number): void {
  if (err == null || depth > 4) return;
  if (typeof err === "string") {
    out.push(err);
    return;
  }
  if (err instanceof Error) {
    out.push(err.message);
    return;
  }
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    for (const key of ["message", "error", "error_message", "detail", "responseBody", "data", "cause"]) {
      const v = o[key];
      if (typeof v === "string") out.push(v);
      else if (v && typeof v === "object") collectMessages(v, out, depth + 1);
    }
  }
}

/**
 * Recognise a Cline SDK auth failure: the provider rejected the request's
 * credentials (HTTP 401/403), the token/key is invalid/expired, or no
 * credentials were configured at all.
 */
export function detectAuthFailure(err: unknown): boolean {
  if (err == null) return false;

  // 1. The SDK's own coarse classification: HTTP 401/403 -> "auth".
  try {
    if (Llms.classifyProviderError(err) === "auth") return true;
  } catch {
    /* ignore — fall through to the structural/message checks */
  }

  // 2. The error event's `errorClass` field (the runtime's classification).
  if (hasAuthErrorClass(err)) return true;

  // 3. Message text heuristics for missing/invalid/expired credentials.
  const messages: string[] = [];
  collectMessages(err, messages, 0);
  return messages.some((m) => AUTH_MESSAGE_PATTERNS.some((re) => re.test(m)));
}
