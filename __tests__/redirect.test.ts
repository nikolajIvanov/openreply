import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    trackedLink: {
      findUnique: vi.fn(),
    },
    linkClick: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

import { GET } from "../app/r/[slug]/route";
import { createRecipientToken, parseRecipientToken } from "@/lib/tracking/server";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_SECRET", "local-redirect-test-secret");
});
afterEach(() => vi.unstubAllEnvs());

describe("tracked link redirect route", () => {
  it("logs a workspace-isolated click and redirects to the destination", async () => {
    mockPrisma.trackedLink.findUnique.mockResolvedValue({
      id: "link_123",
      workspaceId: "workspace_123",
      automationId: "automation_123",
      destinationUrl: "https://example.com/offer",
      automation: {
        instagramAccountId: "instagram_account_123",
      },
    });
    mockPrisma.linkClick.create.mockResolvedValue({});

    const response = await GET(
      new Request("https://manychat-alternative.com/r/abc123", {
        headers: {
          "user-agent": "vitest",
          referer: "https://instagram.com/",
          "x-forwarded-for": "203.0.113.10",
        },
      }) as Parameters<typeof GET>[0],
      { params: Promise.resolve({ slug: "abc123" }) }
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/offer");
    expect(mockPrisma.trackedLink.findUnique).toHaveBeenCalledWith({
      where: { slug: "abc123" },
      select: expect.any(Object),
    });
    expect(mockPrisma.linkClick.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_123",
        automationId: "automation_123",
        instagramAccountId: "instagram_account_123",
        trackedLinkId: "link_123",
        userAgent: "vitest",
        referrer: "https://instagram.com/",
      }),
    });
  });

  it("redirects unknown slugs to the homepage without logging a click", async () => {
    mockPrisma.trackedLink.findUnique.mockResolvedValue(null);

    const response = await GET(
      new Request("https://manychat-alternative.com/r/missing") as Parameters<
        typeof GET
      >[0],
      { params: Promise.resolve({ slug: "missing" }) }
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://manychat-alternative.com/");
    expect(mockPrisma.linkClick.create).not.toHaveBeenCalled();
  });

  it.each(["valid", "forged", "foreign", "missing"])("keeps redirects working with %s recipient attribution", async (mode) => {
    const valid = createRecipientToken("recipient", "campaign")!;
    const token = mode === "valid" ? valid : mode === "foreign" ? createRecipientToken("recipient", "other")! : mode === "forged" ? "v1." + "a".repeat(22) + "." + "b".repeat(22) : "";
    mockPrisma.trackedLink.findUnique.mockResolvedValue({ id: "link", workspaceId: "ws", automationId: "campaign", destinationUrl: "https://example.com/?x=1", automation: { instagramAccountId: "account" } });
    const response = await GET(new Request(`https://example.test/r/slug?r=${token}`) as Parameters<typeof GET>[0], { params: Promise.resolve({ slug: "slug" }) });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/?x=1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mockPrisma.linkClick.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      recipientHash: mode === "valid" ? parseRecipientToken(valid, "campaign") : null,
      workspaceId: "ws", automationId: "campaign",
    }) });
  });
});
