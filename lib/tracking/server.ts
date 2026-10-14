import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function recipientSecret() {
  const secret = process.env.NEXTAUTH_SECRET;
  return secret && secret.trim().length >= 16 ? secret : undefined;
}

/** Campaign-scoped, signed pseudonym. Never expose the Instagram ID or use
 * a public fallback secret. Missing configuration keeps ordinary links valid. */
export function createRecipientToken(recipientId: string, campaignId: string): string | undefined {
  const secret = recipientSecret();
  if (!secret || !recipientId || !campaignId) return undefined;
  const hash = createHmac("sha256", secret)
    .update(JSON.stringify(["recipient-v1", campaignId, recipientId]))
    .digest("base64url").slice(0, 22);
  const signature = createHmac("sha256", secret)
    .update(JSON.stringify(["recipient-token-v1", campaignId, hash]))
    .digest("base64url").slice(0, 22);
  return `v1.${hash}.${signature}`;
}

/** Tokens are attribution hints, not authentication or proof of a human click. */
export function parseRecipientToken(token: string | null, campaignId: string): string | null {
  const secret = recipientSecret();
  if (!secret || !token || !campaignId) return null;
  const match = /^v1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!match) return null;
  const [, hash, signature] = match;
  const expected = createHmac("sha256", secret)
    .update(JSON.stringify(["recipient-token-v1", campaignId, hash]))
    .digest("base64url").slice(0, 22);
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return `v1.${hash}`;
}

export function generateTrackedLinkSlug() {
  return randomBytes(7).toString("base64url");
}

export function hashClickIp(ipAddress: string | null | undefined) {
  if (!ipAddress) return null;

  const salt = process.env.NEXTAUTH_SECRET ?? "campaigncue-click-salt";
  return createHash("sha256").update(`${salt}:${ipAddress}`).digest("hex");
}

export function getRequestIp(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() ?? null;
  }

  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("cf-connecting-ip") ??
    null
  );
}
