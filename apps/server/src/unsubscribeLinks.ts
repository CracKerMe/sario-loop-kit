import { buildOneClickUnsubscribeUrl, buildUnsubscribeUrl } from "@loopkit/core";
import type { UnsubscribeLink, UnsubscribeLinkPayload } from "@loopkit/email";
import { env } from "@loopkit/env/server";

/**
 * Single source of truth for the unsubscribe link's origin and signing key,
 * shared by the two places that must agree on it:
 *
 *  - the email channel, which stamps `List-Unsubscribe` on every send;
 *  - the public endpoint, which verifies the token a mail client POSTs back.
 *
 * If those two ever derived the secret or the origin differently, every
 * one-click unsubscribe would 401 — a silent compliance failure that only
 * shows up as an unexplained rise in spam complaints. Hence one module.
 */

/**
 * Falls back to BETTER_AUTH_SECRET so an existing deployment gains
 * unsubscribe links without a new required env var. Rotating it invalidates
 * links already sitting in inboxes, which is why a dedicated var exists.
 */
export function unsubscribeSecret(): string {
  return env.UNSUBSCRIBE_SECRET ?? env.BETTER_AUTH_SECRET;
}

/** Where the human-facing preference centre lives. */
export function unsubscribePageBaseUrl(): string {
  return env.PUBLIC_APP_URL ?? env.BETTER_AUTH_URL;
}

/** Where the API this process serves is reachable from the public internet. */
export function unsubscribeApiBaseUrl(): string {
  return env.PUBLIC_API_URL ?? env.BETTER_AUTH_URL;
}

/** RFC 8058 one-click target: an empty POST, no cookies, no redirect. */
export function buildOneClickLink(payload: UnsubscribeLinkPayload): UnsubscribeLink {
  return {
    oneClickUrl: buildOneClickUnsubscribeUrl(unsubscribeApiBaseUrl(), payload, unsubscribeSecret()),
    mailtoUrl: `mailto:unsubscribe@${new URL(unsubscribePageBaseUrl()).hostname}?subject=unsubscribe`,
  };
}

/** The link a human clicks in the email body / preference centre. */
export function buildPreferenceCentreLink(payload: UnsubscribeLinkPayload): string {
  return buildUnsubscribeUrl(unsubscribePageBaseUrl(), payload, unsubscribeSecret());
}
