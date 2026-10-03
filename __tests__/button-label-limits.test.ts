import { describe, expect, it } from "vitest";
import { buttonLabelTooLong, INSTAGRAM_BUTTON_LABEL_LIMIT, renderButtonLabel } from "@/lib/instagram/message-limits";
import { contentSchema, resourceSchema } from "@/lib/library/schema";
import { campaignActivationErrors } from "@/lib/campaigns/selection";

const fields = ["openingDmButtonLabel", "followPromptButtonLabel", "linkButtonLabel", "secondaryButtonLabel"];
describe("Instagram button labels", () => {
  it("matches the existing send budget and screenshot, including spaces", () => {
    expect(INSTAGRAM_BUTTON_LABEL_LIMIT).toBe(20);
    expect(renderButtonLabel("Ja, schick mir die Links")).toBe("Ja, schick mir die L");
    expect(renderButtonLabel("Links senden")).toBe("Links senden");
    expect(buttonLabelTooLong("a".repeat(20))).toBe(false);
    expect(buttonLabelTooLong("a".repeat(21))).toBe(true);
    expect(buttonLabelTooLong(null)).toBe(false);
  });
  it("uses the same conservative UTF-16 budget as HTML and Zod", () => {
    expect("😀".length).toBe(2);
    expect(buttonLabelTooLong("😀".repeat(10))).toBe(false);
    expect(buttonLabelTooLong("😀".repeat(11))).toBe(true);
  });
  it.each(["😀", "👍🏽", "👨‍👩‍👧‍👦", "e\u0301"])("never cuts the boundary grapheme %s", (emoji) => {
    expect(renderButtonLabel("a".repeat(19) + emoji + "suffix")).toBe("a".repeat(19));
  });
  it("keeps fitting emoji whole and handles an oversized first grapheme", () => {
    expect(renderButtonLabel("a".repeat(18) + "😀" + "suffix")).toBe("a".repeat(18) + "😀");
    expect(renderButtonLabel("a" + "\u0301".repeat(25))).toBe("Continue");
    expect(renderButtonLabel("")).toBe("");
  });
  it.each(fields)("validates %s for library templates, import and service drafts", (field) => {
    expect(contentSchema.safeParse({ name: "Draft", [field]: "a".repeat(20) }).success).toBe(true);
    const result = contentSchema.safeParse({ name: "Draft", [field]: "a".repeat(21) });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].path).toEqual([field]);
  });
  it("also validates reusable resource labels", () => {
    expect(resourceSchema.safeParse({ destinationUrl: "https://example.com", linkButtonLabel: "a".repeat(21) }).success).toBe(false);
  });
  it("blocks activating historical enabled labels but ignores disabled stages", () => {
    const ready = { matchAnyPost: true, keywords: ["LINK"], matchAnyWord: false, dmMessage: "Resource" };
    expect(campaignActivationErrors({ ...ready, openingDmEnabled: true, openingDmMessage: "Hi", openingDmButtonLabel: "a".repeat(21) })).toContain("Opening DM button label must be at most 20 characters including spaces.");
    expect(campaignActivationErrors({ ...ready, openingDmEnabled: false, openingDmButtonLabel: "a".repeat(21) })).toEqual([]);
    expect(campaignActivationErrors({ ...ready, requireFollow: true, followPromptMessage: "Follow", followPromptButtonLabel: "a".repeat(21) })).toContain("Follow button label must be at most 20 characters including spaces.");
    expect(campaignActivationErrors({ ...ready, trackedDestinationUrl: "https://example.com", linkButtonLabel: "a".repeat(21) })).toContain("Link button label must be at most 20 characters including spaces.");
    expect(campaignActivationErrors({ ...ready, secondaryDestinationUrl: "https://example.com", secondaryButtonLabel: "a".repeat(21) })).toContain("Second link button label must be at most 20 characters including spaces.");
  });
});
