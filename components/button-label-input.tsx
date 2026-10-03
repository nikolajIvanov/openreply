"use client";

import { useId } from "react";
import { useI18n } from "@/lib/i18n/provider";
import { buttonLabelTooLong, INSTAGRAM_BUTTON_LABEL_LIMIT } from "@/lib/instagram/message-limits";

export default function ButtonLabelInput({ value, onChange, placeholder }: {
  value: string; onChange: (value: string) => void; placeholder: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const tooLong = buttonLabelTooLong(value);
  return <div className="space-y-1">
    <label htmlFor={id} className="block text-xs text-muted">{placeholder}</label>
    <input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      maxLength={INSTAGRAM_BUTTON_LABEL_LIMIT} aria-invalid={tooLong} aria-describedby={`${id}-hint`}
      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none" />
    <div id={`${id}-hint`} className={`text-xs ${tooLong ? "text-red-400" : "text-muted"}`}>
      <span className="float-right tabular-nums">{value.length}/{INSTAGRAM_BUTTON_LABEL_LIMIT}</span>
      <p>{t("Instagram buttons: max. {limit} characters including spaces.", { limit: INSTAGRAM_BUTTON_LABEL_LIMIT })}</p>
      <p>{t("Emojis may count as multiple characters. Display width varies by device; keep labels short.")}</p>
      {tooLong && <p role="alert">{t("This button label is too long. Shorten it before saving; the preview shows the shortened send text.")}</p>}
    </div>
  </div>;
}
