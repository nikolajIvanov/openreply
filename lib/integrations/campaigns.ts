import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { contentSchema, httpUrl } from "@/lib/library/schema";
import { buildInitialCampaignLinks, syncCampaignLinks, DEFAULT_LINK_BUTTON_LABEL } from "@/lib/campaigns/links";
import { saveCampaignRevision } from "@/lib/campaigns/mutations";
import { generateReportShareSlug } from "@/lib/reports/share";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import { buttonLabelTooLong } from "@/lib/instagram/message-limits";
import { ApiError } from "./http";
import { requireScope, type ServiceContext } from "./auth";

export const draftSchema = contentSchema.extend({
  instagramAccountId: z.string().min(1).max(100),
  postId: z.string().max(100).nullable().optional(),
  postUrl: httpUrl.nullable().optional(),
  matchAnyPost: z.boolean().default(false),
  pendingNextReel: z.boolean().default(false),
  idempotencyKey: z.string().min(8).max(128),
});

// Zod 4 evaluates inner defaults even through partial(). Remove every default
// before making content optional, so omitted settings never become writes.
const draftChangesSchema = contentSchema.extend({
  keywords: contentSchema.shape.keywords.removeDefault(),
  excludedKeywords: contentSchema.shape.excludedKeywords.removeDefault(),
  matchAnyWord: contentSchema.shape.matchAnyWord.removeDefault(),
  wholeWordMatch: contentSchema.shape.wholeWordMatch.removeDefault(),
  dmTriggerEnabled: contentSchema.shape.dmTriggerEnabled.removeDefault(),
  priority: contentSchema.shape.priority.removeDefault(),
  dmMessage: contentSchema.shape.dmMessage.removeDefault(),
  openingDmEnabled: contentSchema.shape.openingDmEnabled.removeDefault(),
  requireFollow: contentSchema.shape.requireFollow.removeDefault(),
  followUpEnabled: contentSchema.shape.followUpEnabled.removeDefault(),
  followUpDelayMinutes: contentSchema.shape.followUpDelayMinutes.removeDefault(),
  publicReplyEnabled: contentSchema.shape.publicReplyEnabled.removeDefault(),
  publicReplyMessages: contentSchema.shape.publicReplyMessages.removeDefault(),
}).partial().strict();
// Account, post binding, lifecycle and activation are deliberately not editable.
export const updateDraftSchema = z.object({
  id: z.string().min(1).max(100),
  expectedVersion: z.number().int().min(1).max(2147483646),
  changes: draftChangesSchema.refine(
    (changes) => Object.values(changes).some((value) => value !== undefined),
    "Provide at least one content field",
  ),
}).strict();

const safeCampaignSelect = {
  id: true, name: true, goal: true, instagramAccountId: true, lifecycle: true,
  isActive: true, postId: true, postUrl: true, pendingNextReel: true, matchAnyPost: true,
  keywords: true, excludedKeywords: true, matchAnyWord: true, priority: true,
  dmMessage: true, createdAt: true, updatedAt: true,
} as const;

export async function listCampaigns(context: ServiceContext) {
  requireScope(context, "campaigns:read");
  return prisma.automation.findMany({ where: { workspaceId: context.workspaceId },
    select: safeCampaignSelect, orderBy: { createdAt: "desc" }, take: 100 });
}

export async function getCampaign(context: ServiceContext, id: string) {
  requireScope(context, "campaigns:read");
  const campaign = await prisma.automation.findFirst({ where: { id, workspaceId: context.workspaceId },
    select: {
      ...safeCampaignSelect,
      version: true, wholeWordMatch: true, dmTriggerEnabled: true,
      openingDmEnabled: true, openingDmMessage: true, openingDmButtonLabel: true,
      linkButtonLabel: true, requireFollow: true, followPromptMessage: true,
      followPromptButtonLabel: true, followUpEnabled: true, followUpMessage: true,
      followUpDelayMinutes: true, publicReplyEnabled: true, publicReplyMessage: true,
      publicReplyMessages: true,
      trackedLinks: {
        where: { workspaceId: context.workspaceId }, orderBy: TRACKED_LINK_ORDER,
        select: { destinationUrl: true, label: true, position: true },
      },
    } });
  if (!campaign) throw new ApiError("Campaign not found", 404);
  // Match the worker's ordered-button semantics, including legacy position ties.
  const [primary, secondary] = campaign.trackedLinks;
  return { ...campaign,
    trackedDestinationUrl: primary?.destinationUrl ?? null,
    secondaryDestinationUrl: secondary?.destinationUrl ?? null,
    secondaryButtonLabel: secondary?.label ?? null,
  };
}

export async function getCampaignStats(context: ServiceContext, id: string) {
  await getCampaign(context, id);
  const [statuses, rawClicks] = await Promise.all([
    prisma.dmLog.groupBy({ by: ["status"], where: { workspaceId: context.workspaceId, automationId: id }, _count: { _all: true } }),
    prisma.linkClick.count({ where: { workspaceId: context.workspaceId, automationId: id } }),
  ]);
  return { campaignId: id, statuses, rawClicks, note: "Raw link requests include previews and repeated clicks; not unique recipients." };
}

/** Advisory lock + immutable event form one transaction: retry cannot create a second draft. */
export async function createDraft(context: ServiceContext, input: unknown) {
  requireScope(context, "drafts:write");
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  const { idempotencyKey, trackedDestinationUrl, secondaryDestinationUrl, secondaryButtonLabel, ...data } = parsed.data;
  const fingerprint = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");
  const externalId = `draft:${idempotencyKey}`;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${context.workspaceId}:${externalId}`}, 0))`;
    const existing = await tx.integrationEvent.findUnique({ where: { workspaceId_externalId: { workspaceId: context.workspaceId, externalId } } });
    if (existing) {
      const payload = existing.payload as { fingerprint: string; campaignId: string };
      if (payload.fingerprint !== fingerprint) throw new ApiError("Idempotency key already used for different content", 409);
      return { campaignId: payload.campaignId, replayed: true };
    }
    const account = await tx.instagramAccount.findFirst({ where: { id: data.instagramAccountId, workspaceId: context.workspaceId } });
    if (!account) throw new ApiError("Instagram account not found", 404);
    const campaign = await tx.automation.create({ data: {
      ...data, workspaceId: context.workspaceId, isActive: false, lifecycle: "DRAFT", armedAt: null,
      reportShareSlug: generateReportShareSlug(),
      trackedLinks: { create: buildInitialCampaignLinks({ workspaceId: context.workspaceId, primaryUrl: trackedDestinationUrl,
        secondaryUrl: secondaryDestinationUrl, secondaryLabel: secondaryButtonLabel }) },
    } });
    await tx.integrationEvent.create({ data: { workspaceId: context.workspaceId, automationId: campaign.id,
      externalId, eventType: "campaign.draft_created", payload: { campaignId: campaign.id, fingerprint } } });
    await saveCampaignRevision(tx, campaign, context.keyId);
    return { campaignId: campaign.id, replayed: false };
  });
}

/** Content-only optimistic update. The conditional UPDATE locks the row before
 * links and revision are written, serializing edits against UI activation. */
export async function updateDraft(context: ServiceContext, input: unknown) {
  requireScope(context, "drafts:write");
  const parsed = updateDraftSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  const { id, expectedVersion, changes } = parsed.data;
  return prisma.$transaction(async (tx) => {
    const existing = await tx.automation.findFirst({ where: { id, workspaceId: context.workspaceId } });
    if (!existing) throw new ApiError("Campaign not found", 404);
    if (existing.lifecycle !== "DRAFT" || existing.isActive) throw new ApiError("Only inactive DRAFT campaigns can be edited", 409);
    if (existing.version !== expectedVersion) throw new ApiError("Draft version changed; read it again before editing", 409);
    const links = await tx.trackedLink.findMany({ where: { automationId: id }, orderBy: TRACKED_LINK_ORDER });
    if (links.some(link => link.workspaceId !== context.workspaceId)) throw new ApiError("Campaign link workspace mismatch", 409);
    const [primary, secondary] = links;
    const primaryUrl = changes.trackedDestinationUrl === undefined ? primary?.destinationUrl ?? null : changes.trackedDestinationUrl;
    const secondaryUrl = changes.secondaryDestinationUrl === undefined ? secondary?.destinationUrl ?? null : changes.secondaryDestinationUrl;
    const secondaryLabel = changes.secondaryButtonLabel === undefined ? secondary?.label ?? null : changes.secondaryButtonLabel;
    if (!primaryUrl && secondaryUrl) throw new ApiError("A second link requires a primary link; remove both links together if needed");
    if (changes.secondaryButtonLabel !== undefined && !secondaryUrl) throw new ApiError("A second button label requires a second link");

    // Validate the resulting snapshot, but save only supplied fields, not parsed defaults.
    const candidate = Object.fromEntries(Object.keys(contentSchema.shape).map(key => [key, Reflect.get(existing, key)]));
    const validation = contentSchema.safeParse({ ...candidate, ...changes,
      trackedDestinationUrl: primaryUrl, secondaryDestinationUrl: secondaryUrl, secondaryButtonLabel: secondaryLabel });
    if (!validation.success) throw new ApiError(validation.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
    const { trackedDestinationUrl, secondaryDestinationUrl, secondaryButtonLabel, ...fields } = changes;
    const updated = await tx.automation.updateMany({
      where: { id, workspaceId: context.workspaceId, lifecycle: "DRAFT", isActive: false, version: expectedVersion },
      data: { ...fields, version: { increment: 1 } },
    });
    if (updated.count !== 1) throw new ApiError("Draft changed; read it again before editing", 409);
    await syncCampaignLinks(tx, {
      workspaceId: context.workspaceId, automationId: id,
      primaryUrl: trackedDestinationUrl === undefined ? undefined : trackedDestinationUrl ?? "",
      // The shared helper needs the URL to update a secondary label by itself.
      secondaryUrl: secondaryDestinationUrl === undefined
        ? secondaryButtonLabel === undefined ? undefined : secondaryUrl ?? ""
        : secondaryDestinationUrl ?? "",
      secondaryLabel: secondaryLabel ?? DEFAULT_LINK_BUTTON_LABEL,
    });
    const campaign = await tx.automation.findUniqueOrThrow({ where: { id } });
    // Validate the actual stored order/fallback after syncing. A newly created
    // primary link has its own internal label, which is not a safe UI fallback.
    const finalLinks = await tx.trackedLink.findMany({ where: { automationId: id, workspaceId: context.workspaceId }, orderBy: TRACKED_LINK_ORDER, take: 3 });
    for (const [index, link] of finalLinks.entries()) {
      const title = (index === 0 ? campaign.linkButtonLabel : link.label) || link.label || DEFAULT_LINK_BUTTON_LABEL;
      if (buttonLabelTooLong(title)) throw new ApiError("Effective link button label must be at most 20 characters including spaces");
    }
    await saveCampaignRevision(tx, campaign, context.keyId);
    return { campaignId: id, version: campaign.version };
  });
}
