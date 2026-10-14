import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecipientToken, parseRecipientToken } from "@/lib/tracking/server";
import { buildTrackedUrl, personalizeExistingTrackedUrls, renderMessageWithTracking } from "@/lib/tracking/message";

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", "local-recipient-tracking-secret");
  vi.stubEnv("NEXTAUTH_URL", "https://example.test");
});
afterEach(() => vi.unstubAllEnvs());
const links = [{ slug: "first", destinationUrl: "https://example.com/first" }, { slug: "second", destinationUrl: "https://example.com/second" }];

describe("signed recipient attribution", () => {
  it("is deterministic, pseudonymous, campaign-bound and recipient-specific", () => {
    const token = createRecipientToken("recipient-private-id", "campaign")!;
    expect(token).toMatch(/^v1\.[\w-]{22}\.[\w-]{22}$/);
    expect(token).not.toContain("recipient-private-id");
    expect(createRecipientToken("recipient-private-id", "campaign")).toBe(token);
    expect(createRecipientToken("other", "campaign")).not.toBe(token);
    expect(createRecipientToken("recipient-private-id", "other")).not.toBe(token);
    expect(parseRecipientToken(token, "campaign")).toMatch(/^v1\.[\w-]{22}$/);
    expect(parseRecipientToken(token, "other")).toBeNull();
  });
  it.each(["", "short", "                "])("does not use a public fallback for a missing or weak secret", (secret) => {
    const token = createRecipientToken("recipient", "campaign")!;
    vi.stubEnv("NEXTAUTH_SECRET", secret);
    expect(createRecipientToken("recipient", "campaign")).toBeUndefined();
    expect(parseRecipientToken(token, "campaign")).toBeNull();
  });
  it("rejects tampered tokens, legacy unsigned hashes, and tokens after secret rotation", () => {
    const token = createRecipientToken("recipient", "campaign")!;
    const parts = token.split(".");
    expect(parseRecipientToken(`v1.${"a".repeat(22)}.${parts[2]}`, "campaign")).toBeNull();
    expect(parseRecipientToken(token + ".extra", "campaign")).toBeNull();
    expect(parseRecipientToken("a".repeat(22), "campaign")).toBeNull();
    vi.stubEnv("NEXTAUTH_SECRET", "different-local-tracking-secret");
    expect(parseRecipientToken(token, "campaign")).toBeNull();
  });
  it("personalizes button and inline URLs without changing their legacy form", () => {
    const token = createRecipientToken("recipient", "campaign")!;
    expect(buildTrackedUrl("first")).toBe("https://example.test/r/first");
    const url = buildTrackedUrl("first", undefined, token);
    expect(new URL(url).searchParams.get("r")).toBe(token);
    expect(renderMessageWithTracking({ message: "Here {link}", trackedLinks: links, recipientToken: token })).toBe(`Here ${url}`);
  });
  it("only rewrites exact existing own tracking links, preserving query, fragment and punctuation", () => {
    const token = createRecipientToken("recipient", "campaign")!;
    const original = "Open https://example.test/r/first?x=1&r=old#section. Then https://example.test/r/second";
    const result = personalizeExistingTrackedUrls(original, links, token);
    expect(result).toBe(`Open https://example.test/r/first?x=1&r=${token}#section. Then https://example.test/r/second?r=${token}`);
    expect(personalizeExistingTrackedUrls(result, links, token)).toBe(result);
    for (const url of ["https://external.test/r/first", "https://example.test/r/first-extra", "https://example.test/r/unlisted", "https://example.com/first", "https://user:pass@example.test/r/first"]) {
      expect(personalizeExistingTrackedUrls(url, links, token)).toBe(url);
    }
    expect(personalizeExistingTrackedUrls(original, links)).toBe(original);
  });
  it("keeps long inline and follow-up text intact by dropping added attribution, not content", () => {
    const token = createRecipientToken("recipient", "campaign")!;
    const url = buildTrackedUrl("first");
    const prefix = "x".repeat(960 - url.length);
    const message = `${prefix}${url}`;
    expect(message.length).toBe(960);
    expect(personalizeExistingTrackedUrls(message, links, token)).toBe(message);
    const placeholder = `${prefix}{link}`;
    expect(renderMessageWithTracking({ message: placeholder, trackedLinks: links, recipientToken: token })).toBe(message);
    const shortMessage = "Read " + url;
    expect(personalizeExistingTrackedUrls(shortMessage, links, token)).toContain(`?r=${token}`);
  });
});
