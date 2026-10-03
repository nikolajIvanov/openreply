import { authenticateService } from "@/lib/integrations/auth";
import { createDraft, getCampaign, getCampaignStats, listCampaigns, updateDraft } from "@/lib/integrations/campaigns";
import { apiError, readJson } from "@/lib/integrations/http";
export async function GET(request: Request) {
  try {
    const context = await authenticateService(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const data = id ? url.searchParams.has("stats") ? await getCampaignStats(context, id) : await getCampaign(context, id) : await listCampaigns(context);
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try { return Response.json(await createDraft(await authenticateService(request), await readJson(request)), { status: 201 }); }
  catch (error) { return apiError(error); }
}
export async function PATCH(request: Request) {
  try { return Response.json(await updateDraft(await authenticateService(request), await readJson(request)), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return apiError(error); }
}
