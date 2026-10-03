/** Instagram URL and postback buttons have a 20-character title limit.
 * Provider reference: https://developers.cm.com/messaging/docs/instagram-messaging
 * We conservatively budget UTF-16 units, matching HTML maxLength and Zod.
 * This is not a claim about Meta's Unicode counting implementation.
 */
export const INSTAGRAM_BUTTON_LABEL_LIMIT = 20;

export function buttonLabelTooLong(value: string | null | undefined) {
  return (value?.length ?? 0) > INSTAGRAM_BUTTON_LABEL_LIMIT;
}

/** Compatibility fallback for existing campaigns, never a stored-value rewrite.
 * Keep whole graphemes: slicing UTF-16 can break emoji/surrogate pairs.
 */
export function renderButtonLabel(value: string): string {
  if (!buttonLabelTooLong(value)) return value;
  let result = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) {
    if (result.length + segment.length > INSTAGRAM_BUTTON_LABEL_LIMIT) break;
    result += segment;
  }
  return result || "Continue";
}
