import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { safeDeliveryError, safeRevisionSnapshot } from "@/lib/campaigns/history";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ success: false, error: "Missing campaign ID" }, { status: 400 });
  const campaign = await prisma.automation.findFirst({ where: { id, workspaceId }, select: { id: true, lifecycle: true, version: true } });
  if (!campaign) return NextResponse.json({ success: false, error: "Campaign not found" }, { status: 404 });
  const [delivery, revisions, conversions] = await Promise.all([
    prisma.deliveryEvent.findMany({ where: { workspaceId, automationId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100,
      select: { id: true, stage: true, status: true, campaignVersion: true, message: true, error: true, attempts: true, scheduledAt: true, claimedAt: true, sentAt: true, createdAt: true, updatedAt: true } }),
    prisma.campaignRevision.findMany({ where: { workspaceId, automationId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50,
      select: { id: true, actorId: true, snapshot: true, createdAt: true } }),
    prisma.integrationEvent.groupBy({ by: ["eventType"], where: { workspaceId, automationId: id, eventType: { startsWith: "conversion." } }, _count: { _all: true } }),
  ]);
  return NextResponse.json({ success: true, data: {
    campaign, delivery: delivery.map((item) => ({ ...item, error: safeDeliveryError(item.error) })),
    revisions: revisions.map((item) => ({ ...item, snapshot: safeRevisionSnapshot(item.snapshot) })),
    conversions: conversions.map((item) => ({ eventType: item.eventType, count: item._count._all })),
    limits: { delivery: 100, revisions: 50 },
  } }, { headers: { "Cache-Control": "no-store" } });
}
