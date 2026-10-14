import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

export interface ClickScope {
  workspaceId: string;
  instagramAccountId?: string;
  automationId?: string;
  from?: Date;
  to?: Date;
}
export interface ClickMetrics { key: string; rawClicks: number; deduplicatedClicks: number }

/** Aggregate in PostgreSQL rather than fetching an unbounded click history.
 * A token identifies its addressed recipient, an IP only a network, and a
 * tokenless/IP-less row only itself. Never call these verified unique people. */
export async function getClickMetrics(scope: ClickScope, group: "all" | "campaign" | "link" = "all"): Promise<ClickMetrics[]> {
  if (!scope.workspaceId.trim()) throw new Error("Click metrics require a workspace");
  const filters = [Prisma.sql`"workspaceId" = ${scope.workspaceId}`];
  if (scope.instagramAccountId !== undefined) filters.push(Prisma.sql`"instagramAccountId" = ${scope.instagramAccountId}`);
  if (scope.automationId !== undefined) filters.push(Prisma.sql`"automationId" = ${scope.automationId}`);
  if (scope.from) filters.push(Prisma.sql`"createdAt" >= ${scope.from}`);
  if (scope.to) filters.push(Prisma.sql`"createdAt" < ${scope.to}`);
  const key = group === "campaign" ? Prisma.sql`"automationId"` : group === "link" ? Prisma.sql`"trackedLinkId"` : Prisma.sql`'all'::text`;
  const rows = await prisma.$queryRaw<{ key: string; rawClicks: bigint; deduplicatedClicks: bigint }[]>(Prisma.sql`
    SELECT ${key} AS "key", COUNT(*) AS "rawClicks",
      COUNT(DISTINCT ROW("automationId", COALESCE(
        'r:' || NULLIF("recipientHash", ''),
        'ip:' || NULLIF("ipHash", ''), 'row:' || "id"
      ))) AS "deduplicatedClicks"
    FROM "LinkClick" WHERE ${Prisma.join(filters, " AND ")}
    ${group === "all" ? Prisma.empty : Prisma.sql`GROUP BY ${key}`}
  `);
  return rows.map(row => ({ key: row.key, rawClicks: Number(row.rawClicks), deduplicatedClicks: Number(row.deduplicatedClicks) }));
}
