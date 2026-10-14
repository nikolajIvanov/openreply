export interface MessageTrackedLink {
  slug: string;
  destinationUrl: string;
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/i;
// Conservative application budget for adding attribution to plain text, not
// a claim about every Meta transport. Fall back to legacy URLs, never truncate.
export const RECIPIENT_TEXT_BUDGET = 1000;

function trimTrailingPunctuation(url: string) {
  return url.replace(/[.,!?;:]+$/, "");
}

export function extractFirstUrl(message: string): string | null {
  const match = message.match(URL_PATTERN);
  if (!match) return null;

  try {
    const url = trimTrailingPunctuation(match[0]);
    return new URL(url).toString();
  } catch {
    return null;
  }
}

export function replaceUrlWithTrackedPlaceholder(
  message: string,
  destinationUrl: string | null | undefined
) {
  if (!destinationUrl) return message;
  if (message.includes(destinationUrl)) {
    return message.replace(destinationUrl, "{link}");
  }

  const withoutTrailingSlash = destinationUrl.replace(/\/$/, "");
  return message.replace(withoutTrailingSlash, "{link}");
}

/**
 * Personalize {username} and strip the {link} token — used when the link is
 * delivered as a separate button rather than inline in the message text.
 */
export function renderMessageWithoutLink({
  message,
  commenterName,
}: {
  message: string;
  commenterName?: string | null;
}) {
  return message
    .replace(/\{username\}/gi, commenterName ?? "there")
    .replace(/\s*\{link\}\s*/gi, " ")
    .trim();
}

export function buildTrackedUrl(slug: string, baseUrl?: string, recipientToken?: string) {
  const resolvedBaseUrl =
    baseUrl ??
    (typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXTAUTH_URL ?? "http://localhost:3000");

  const url = `${resolvedBaseUrl.replace(/\/$/, "")}/r/${slug}`;
  return recipientToken ? `${url}?r=${encodeURIComponent(recipientToken)}` : url;
}

/** Add attribution only to existing links in this campaign on our own origin.
 * Used when snapshotting a follow-up; never changes an already queued snapshot. */
export function personalizeExistingTrackedUrls(message: string, links: MessageTrackedLink[], recipientToken?: string) {
  if (!recipientToken || !links.length) return message;
  const allowed = new Set(links.map(link => buildTrackedUrl(link.slug)));
  const personalized = message.replace(/https?:\/\/[^\s<>"')\]]+/gi, (value) => {
    const clean = trimTrailingPunctuation(value);
    try {
      const url = new URL(clean);
      if (url.username || url.password) return value;
      if (!allowed.has(`${url.origin}${url.pathname}`)) return value;
      url.searchParams.set("r", recipientToken);
      return url.toString() + value.slice(clean.length);
    } catch { return value; }
  });
  return personalized.length <= RECIPIENT_TEXT_BUDGET ? personalized : message;
}

export function renderMessageWithTracking({
  message,
  commenterName,
  trackedLinks,
  baseUrl,
  recipientToken,
}: {
  message: string;
  commenterName?: string | null;
  trackedLinks?: MessageTrackedLink[];
  baseUrl?: string;
  recipientToken?: string;
}): string {
  let rendered = message.replace(/\{username\}/gi, commenterName ?? "there");
  const primaryLink = trackedLinks?.[0];

  if (!primaryLink) return rendered;

  const trackedUrl = buildTrackedUrl(primaryLink.slug, baseUrl, recipientToken);

  if (/\{link\}/i.test(rendered)) {
    rendered = rendered.replace(/\{link\}/gi, trackedUrl);
  } else if (rendered.includes(primaryLink.destinationUrl)) {
    rendered = rendered.replaceAll(primaryLink.destinationUrl, trackedUrl);
  } else {
    const withoutTrailingSlash = primaryLink.destinationUrl.replace(/\/$/, "");
    rendered = rendered.replaceAll(withoutTrailingSlash, trackedUrl);
  }

  return recipientToken && rendered.length > RECIPIENT_TEXT_BUDGET
    ? renderMessageWithTracking({ message, commenterName, trackedLinks, baseUrl })
    : rendered;
}
