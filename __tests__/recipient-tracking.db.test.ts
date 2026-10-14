/** Real additive migration, SQL aggregation and API/MCP compatibility in a
 * random disposable schema. Does not enqueue or call any provider. */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/app/generated/prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ db: undefined as unknown as PrismaClient, workspace: "ws" }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: async () => state.workspace, getCurrentUserId: async () => "owner" }));
import { getClickMetrics } from "@/lib/tracking/queries";
import { getCampaignStats } from "@/lib/integrations/campaigns";
import { callTool } from "@/lib/integrations/mcp";
import { getCampaignReportBySlug } from "@/lib/reports/data";
import { GET as dashboard } from "@/app/api/dashboard/stats/route";
import { GET as campaigns } from "@/app/api/automations/route";

const dbUrl = process.env.TEST_DATABASE_URL;
const schema = `recipient_clicks_${randomBytes(6).toString("hex")}`;
const migration = "20261014090000_link_click_recipient";
let sql: Client;
const context = { workspaceId: "ws", keyId: "local", scopes: ["campaigns:read"] };

describe.skipIf(!dbUrl)("recipient tracking on PostgreSQL", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: dbUrl }); await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`); await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    for (const dir of readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()) {
      if (dir !== migration) await sql.query(readFileSync(path.join(root, dir, "migration.sql"), "utf8"));
    }
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl, max: 4, options: `-c search_path=${schema}` }, { schema }) });
    await state.db.user.create({ data: { id: "owner", email: "tracking-owner@example.test" } });
    for (const ws of ["ws", "other"]) {
      await state.db.workspace.create({ data: { id: ws, name: ws, ownerId: "owner" } });
      await state.db.instagramAccount.create({ data: { id: `${ws}-account`, workspaceId: ws, username: ws, instagramId: ws, accessToken: "DUMMY" } });
      for (const id of ws === "ws" ? ["first", "second"] : ["foreign"]) {
        await state.db.automation.create({ data: { id, workspaceId: ws, instagramAccountId: `${ws}-account`, name: id, dmMessage: "Draft", reportShareSlug: `report-${id}`, reportShareEnabled: true,
          trackedLinks: { create: { id: `${id}-link`, workspaceId: ws, slug: `${id}-slug`, destinationUrl: "https://example.com/resource" } } } });
      }
    }
    await sql.query(`INSERT INTO "LinkClick" (id,"workspaceId","automationId","instagramAccountId","trackedLinkId","ipHash") VALUES ('legacy','ws','first','ws-account','first-link','legacy-ip')`);
    const content = readFileSync(path.join(root, migration, "migration.sql"), "utf8");
    await sql.query(content); await sql.query(content);
    const inputs = [
      ["a1", "first", "v1.recipient-a", "ip-a"], ["a2", "first", "v1.recipient-a", "different-ip"],
      ["b", "first", "v1.recipient-b", "ip-a"], ["ip1", "first", null, "shared-ip"], ["ip2", "first", null, "shared-ip"],
      ["anon1", "first", null, null], ["anon2", "first", null, null],
      ["same-recipient-other-campaign", "second", "v1.recipient-a", null],
    ];
    for (const [id, campaign, recipientHash, ipHash] of inputs) {
      await state.db.linkClick.create({ data: { id: id!, workspaceId: "ws", automationId: campaign!, instagramAccountId: "ws-account", trackedLinkId: `${campaign}-link`, recipientHash, ipHash } });
    }
    await state.db.linkClick.create({ data: { id: "outside", workspaceId: "other", automationId: "foreign", instagramAccountId: "other-account", trackedLinkId: "foreign-link", recipientHash: "v1.recipient-a" } });
    await state.db.dmLog.create({ data: { id: "sent", workspaceId: "ws", automationId: "first", instagramAccountId: "ws-account", commenterId: "recipient", commentId: "comment", commentText: "RESOURCE", status: "SENT" } });
  }, 60_000);
  afterAll(async () => { await state.db?.$disconnect(); if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); } });

  it("preserves legacy rows through a nullable, replayable migration", async () => {
    expect(await state.db.linkClick.findUniqueOrThrow({ where: { id: "legacy" } })).toMatchObject({ recipientHash: null, ipHash: "legacy-ip" });
  });
  it("deduplicates tokens then IPs then row IDs within each campaign", async () => {
    expect(await getClickMetrics({ workspaceId: "ws", automationId: "first" })).toEqual([{ key: "all", rawClicks: 8, deduplicatedClicks: 6 }]);
    expect(await getClickMetrics({ workspaceId: "ws" })).toEqual([{ key: "all", rawClicks: 9, deduplicatedClicks: 7 }]);
    expect(await getClickMetrics({ workspaceId: "ws" }, "campaign")).toEqual(expect.arrayContaining([
      { key: "first", rawClicks: 8, deduplicatedClicks: 6 }, { key: "second", rawClicks: 1, deduplicatedClicks: 1 },
    ]));
    expect(await getClickMetrics({ workspaceId: "ws", automationId: "first" }, "link")).toEqual([{ key: "first-link", rawClicks: 8, deduplicatedClicks: 6 }]);
  });
  it("enforces workspace, account, campaign and date scopes with bound parameters", async () => {
    expect(await getClickMetrics({ workspaceId: "other" })).toEqual([{ key: "all", rawClicks: 1, deduplicatedClicks: 1 }]);
    for (const scope of [{ workspaceId: "ws", instagramAccountId: "other-account" }, { workspaceId: "ws", automationId: "foreign" }, { workspaceId: "ws' OR TRUE --" }, { workspaceId: "ws", from: new Date("2099-01-01") }, { workspaceId: "ws", to: new Date("2000-01-01") }]) {
      expect(await getClickMetrics(scope)).toEqual([{ key: "all", rawClicks: 0, deduplicatedClicks: 0 }]);
    }
    await expect(getClickMetrics({ workspaceId: "" })).rejects.toThrow("workspace");
  });
  it("keeps API and MCP raw-click stats unchanged", async () => {
    const expected = { campaignId: "first", rawClicks: 8, note: "Raw link requests include previews and repeated clicks; not unique recipients." };
    expect(await getCampaignStats(context, "first")).toMatchObject(expected);
    expect(await callTool(context, "get_campaign_stats", { id: "first" })).toMatchObject(expected);
  });
  it("adds dashboard and campaign metrics without replacing raw counts or ratios", async () => {
    const response = await dashboard(new NextRequest("http://localhost/api/dashboard/stats"));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ clicksThisMonth: 9, totalClicks: 9, deduplicatedClicksThisMonth: 7, totalDeduplicatedClicks: 7, ctrThisMonth: 900 });
    const filtered = await dashboard(new NextRequest("http://localhost/api/dashboard/stats?instagramAccountId=other-account"));
    expect((await filtered.json()).data).toMatchObject({ totalClicks: 0, totalDeduplicatedClicks: 0 });
    const listing = await campaigns(new NextRequest("http://localhost/api/automations"));
    expect((await listing.json()).data.find((row: { id: string }) => row.id === "first").analytics).toMatchObject({ clicks: 8, deduplicatedClicks: 6, ctr: 800 });
  });
  it("keeps shared-report raw totals while adding aggregate-only pseudonymous metrics", async () => {
    const report = await getCampaignReportBySlug("report-first");
    expect(report?.metrics).toMatchObject({ clicks: 8, deduplicatedClicks: 6, ctr: 800 });
    expect(report?.trackedLinks[0]).toMatchObject({ clicks: 8, deduplicatedClicks: 6 });
    expect(JSON.stringify(report)).not.toContain("recipientHash");
    expect(JSON.stringify(report)).not.toContain("v1.recipient-a");
  });
  it("returns aggregate-sized output with 10000 repeated requests and preserves type prefixes", async () => {
    await sql.query(`INSERT INTO "LinkClick" (id,"workspaceId","automationId","instagramAccountId","trackedLinkId","recipientHash","ipHash") SELECT 'bulk-' || n,'ws','second','ws-account','second-link','bulk','bulk' FROM generate_series(1,10000) AS n`);
    await state.db.linkClick.create({ data: { id: "ip-bulk", workspaceId: "ws", automationId: "second", instagramAccountId: "ws-account", trackedLinkId: "second-link", ipHash: "bulk" } });
    expect(await getClickMetrics({ workspaceId: "ws", automationId: "second" })).toEqual([{ key: "all", rawClicks: 10002, deduplicatedClicks: 3 }]);
  });
});
