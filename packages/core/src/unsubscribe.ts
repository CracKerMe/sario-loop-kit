import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless, tamper-evident unsubscribe/preference tokens.
 *
 * Design constraints, in order of importance:
 *
 *  1. **No new table and no login.** The link lives in an email and is
 *     clicked by someone who has no account. A signed payload needs no
 *     lookup, no expiry sweeper, and no row to get out of sync.
 *  2. **Address-scoped, not just identity-scoped.** The token carries the
 *     email address as well as the contact id, so a one-click unsubscribe
 *     still records a suppression even if the contact row has since been
 *     deleted (the common case: imported for one campaign, cleaned up,
 *     then bounced mail arrives).
 *  3. **Expiring but not short-lived.** These links sit in inboxes for
 *     months. An unbounded token is a permanent capability leak in every
 *     archived copy of every email, so there is a TTL — default 180 days,
 *     which outlives realistic list hygiene cycles.
 *
 * The signature is over the exact encoded payload string, so the payload
 * cannot be edited (workspace swapped, contact swapped) without
 * invalidating it. Comparison is constant-time.
 */

export interface UnsubscribeTokenPayload {
  workspaceId: string;
  contactId: string;
  email: string;
  /** Optional: which journey/campaign the click came from, for reporting. */
  journeyId?: string;
  campaignId?: string;
}

export interface VerifiedUnsubscribeToken extends UnsubscribeTokenPayload {
  expiresAt: Date;
}

const DEFAULT_TTL_SECONDS = 180 * 86_400;

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export interface CreateUnsubscribeTokenOptions {
  ttlSeconds?: number;
  /** Injectable for deterministic tests; defaults to now. */
  now?: Date;
}

/**
 * `base64url(payload).base64url(hmac)` — two base64url segments, so the
 * whole token is URL-safe with no percent-encoding and no `+`/`/` to be
 * mangled by a mail client's link rewriter.
 */
export function createUnsubscribeToken(
  payload: UnsubscribeTokenPayload,
  secret: string,
  options: CreateUnsubscribeTokenOptions = {},
): string {
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const now = options.now ?? new Date();
  const expiresAt = Math.floor(now.getTime() / 1000) + ttl;

  const body = {
    w: payload.workspaceId,
    c: payload.contactId,
    e: payload.email.trim().toLowerCase(),
    ...(payload.journeyId ? { j: payload.journeyId } : {}),
    ...(payload.campaignId ? { m: payload.campaignId } : {}),
    exp: expiresAt,
  };

  const encoded = base64url(JSON.stringify(body));
  return `${encoded}.${sign(encoded, secret)}`;
}

/**
 * Returns the payload, or `null` for anything that is not a valid,
 * unexpired token. Deliberately returns null rather than throwing or
 * distinguishing "bad signature" from "expired": this is reached from a
 * public endpoint with attacker-controlled input, and there is no reason to
 * tell a prober which part was wrong.
 */
export function verifyUnsubscribeToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): VerifiedUnsubscribeToken | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts as [string, string];
  if (!encoded || !signature) return null;

  const expected = sign(encoded, secret);
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself leak
  // length — compare lengths first, then in constant time.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let body: {
    w?: unknown;
    c?: unknown;
    e?: unknown;
    j?: unknown;
    m?: unknown;
    exp?: unknown;
  };
  try {
    body = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof body.w !== "string" || typeof body.c !== "string" || typeof body.e !== "string") {
    return null;
  }
  if (typeof body.exp !== "number" || !Number.isFinite(body.exp)) return null;

  const expiresAt = new Date(body.exp * 1000);
  if (expiresAt.getTime() <= now.getTime()) return null;

  return {
    workspaceId: body.w,
    contactId: body.c,
    email: body.e,
    ...(typeof body.j === "string" ? { journeyId: body.j } : {}),
    ...(typeof body.m === "string" ? { campaignId: body.m } : {}),
    expiresAt,
  };
}

/**
 * The human-facing preference-centre URL. `baseUrl` is the dashboard origin
 * (the page that renders the opt-out UI), not the API origin.
 */
export function buildUnsubscribeUrl(
  baseUrl: string,
  payload: UnsubscribeTokenPayload,
  secret: string,
  options: CreateUnsubscribeTokenOptions = {},
): string {
  const token = createUnsubscribeToken(payload, secret, options);
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * The same URL with `/api` semantics for a mailbox provider's one-click
 * POST. `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058)
 * requires the POST target to accept an empty body with no cookies and no
 * redirect to a confirmation page, so it hits the API endpoint rather than
 * the page.
 */
export function buildOneClickUnsubscribeUrl(
  apiBaseUrl: string,
  payload: UnsubscribeTokenPayload,
  secret: string,
  options: CreateUnsubscribeTokenOptions = {},
): string {
  const token = createUnsubscribeToken(payload, secret, options);
  const base = apiBaseUrl.replace(/\/+$/, "");
  return `${base}/v1/public/unsubscribe?token=${encodeURIComponent(token)}`;
}
