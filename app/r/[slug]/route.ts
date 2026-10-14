import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getRequestIp, hashClickIp, parseRecipientToken } from "@/lib/tracking/server";

type RedirectRouteProps = {
  params: Promise<{ slug: string }>;
};

export async function GET(request: NextRequest, { params }: RedirectRouteProps) {
  const { slug } = await params;
  const trackedLink = await prisma.trackedLink.findUnique({
    where: { slug },
    select: {
      id: true,
      workspaceId: true,
      automationId: true,
      destinationUrl: true,
      automation: {
        select: {
          instagramAccountId: true,
        },
      },
    },
  });

  if (!trackedLink) {
    return NextResponse.redirect(new URL("/", request.url), { status: 302 });
  }

  await prisma.linkClick.create({
    data: {
      workspaceId: trackedLink.workspaceId,
      automationId: trackedLink.automationId,
      instagramAccountId: trackedLink.automation.instagramAccountId,
      trackedLinkId: trackedLink.id,
      ipHash: hashClickIp(getRequestIp(request)),
      recipientHash: parseRecipientToken(new URL(request.url).searchParams.get("r"), trackedLink.automationId),
      userAgent: request.headers.get("user-agent"),
      referrer: request.headers.get("referer"),
    },
  });

  // Recipient-specific redirects must not be cached or expose their query via
  // a destination Referer. The destination URL itself is never personalized.
  const response = NextResponse.redirect(trackedLink.destinationUrl, { status: 302 });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
