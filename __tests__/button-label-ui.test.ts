import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import ButtonLabelInput from "@/components/button-label-input";
import CampaignPreview from "@/components/campaign-preview";
import { I18nProvider } from "@/lib/i18n/provider";

// Vitest's JSX transform is classic; production Next.js uses automatic JSX.
vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());
describe("button label UI server rendering", () => {
  it("renders the shared input limit, accessible counter and legacy warning", () => {
    const markup = renderToStaticMarkup(createElement(ButtonLabelInput, { value: "Ja, schick mir die Links", onChange: () => {}, placeholder: "Opening button" }));
    expect(markup).toContain('maxLength="20"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain("24/20");
    expect(markup).toContain("including spaces");
    expect(markup).toContain("Emojis may count as multiple characters");
    expect(markup).toContain("Shorten it before saving");
    expect(markup).toContain('aria-describedby=');
  });
  it("renders healthy exact-limit labels without an error and translates the limit", () => {
    const markup = renderToStaticMarkup(createElement(I18nProvider, { locale: "zh-TW" } as React.ComponentProps<typeof I18nProvider>, createElement(ButtonLabelInput, { value: "a".repeat(20), onChange: () => {}, placeholder: "Button" })));
    expect(markup).toContain("20/20");
    expect(markup).toContain('aria-invalid="false"');
    expect(markup).toContain("最多 20 個字元");
    expect(markup).not.toContain('role="alert"');
  });
  it("shows the same shortened title in the opening button and returned message, with a warning", () => {
    const markup = renderToStaticMarkup(createElement(CampaignPreview, {
      tab: "dm", onTabChange: () => {}, username: "test", avatarUrl: null, postThumb: null, caption: "", sampleComment: "link",
      dmTriggerEnabled: false, publicReplyEnabled: false, publicReplyMessage: "", openingDmEnabled: true, openingDmMessage: "Hi",
      openingDmButtonLabel: "Ja, schick mir die Links", revealMessage: "Here is {link}", hasLink: true, linkButtonLabel: "Open",
      hasSecondLink: false, secondLinkButtonLabel: "", requireFollow: false, followPromptMessage: "", followPromptButtonLabel: "",
      followUpEnabled: false, followUpMessage: "",
    }));
    expect(markup).not.toContain("Ja, schick mir die Links");
    expect(markup.split("Ja, schick mir die L")).toHaveLength(3);
    expect(markup).toContain("Overlong button labels are shortened");
  });
});
