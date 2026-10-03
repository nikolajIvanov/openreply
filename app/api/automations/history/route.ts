import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ success: false, error: "Missing campaign ID" }, { status: 400 });
  const data = await prisma.campaignRevision.findMany({ where: { workspaceId, automationId: id }, orderBy: { createdAt: "desc" }, take: 50 });
  return NextResponse.json({ success: true, data }, { headers: { "Cache-Control": "no-store" } });
}
