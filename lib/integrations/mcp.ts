import { z } from "zod";
import { campaignActivationErrors } from "@/lib/campaigns/selection";
import { contentSchema } from "@/lib/library/schema";
import { createDraft, draftSchema, getCampaign, getCampaignStats, listCampaigns } from "./campaigns";
import { ApiError } from "./http";
import { type ServiceContext, requireScope } from "./auth";

const toolDefinitions = [
  { name: "list_campaigns", description: "List up to 100 campaigns in this workspace", inputSchema: { type: "object", properties: {}, additionalProperties: false }, scope: "campaigns:read" },
  { name: "get_campaign", description: "Read one campaign", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, scope: "campaigns:read" },
  { name: "get_campaign_stats", description: "Read send outcomes and raw link requests (not recipient conversion)", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, scope: "campaigns:read" },
  { name: "create_draft", description: "Create a non-sending draft. Explicit links only; do not invent URLs. Supply a stable idempotencyKey. Review and publish in the application.", inputSchema: z.toJSONSchema(draftSchema), scope: "drafts:write" },
  { name: "validate_campaign", description: "Check draft completeness without sending. Not proof of Meta permission or delivery.", inputSchema: z.toJSONSchema(contentSchema.extend({ postId: z.string().optional(), matchAnyPost: z.boolean().optional(), pendingNextReel: z.boolean().optional() })), scope: "drafts:write" },
] as const;
export function listTools(context: ServiceContext) {
  return toolDefinitions.filter(tool => context.scopes.includes(tool.scope)).map(({ scope, ...tool }) => ({
    ...tool, annotations: { readOnlyHint: scope !== "drafts:write" || tool.name === "validate_campaign", destructiveHint: false, openWorldHint: false },
  }));
}
export async function callTool(context: ServiceContext, name: string, args: unknown) {
  if (name === "list_campaigns") return listCampaigns(context);
  if (name === "create_draft") return createDraft(context, args);
  if (name === "validate_campaign") {
    requireScope(context, "drafts:write");
    const input = contentSchema.extend({ postId: z.string().optional(), matchAnyPost: z.boolean().optional(), pendingNextReel: z.boolean().optional() }).safeParse(args);
    if (!input.success) throw new ApiError("Invalid validation input");
    return { errors: campaignActivationErrors(input.data), sendsMessages: false };
  }
  const id = z.object({ id: z.string().min(1).max(100) }).safeParse(args);
  if (!id.success) throw new ApiError("Campaign id required");
  if (name === "get_campaign") return getCampaign(context, id.data.id);
  if (name === "get_campaign_stats") return getCampaignStats(context, id.data.id);
  throw new ApiError("Unknown tool", 404);
}
