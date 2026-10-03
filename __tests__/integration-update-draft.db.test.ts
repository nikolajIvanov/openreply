/** Real migrations and isolated PostgreSQL rows; never queues or provider calls. */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@/app/generated/prisma/client";

const state = vi.hoisted(() => ({ db: undefined as unknown as PrismaClient }));
vi.mock("@/lib/db/client", () => ({ get prisma() { return state.db; } }));
vi.mock("@/lib/integrations/auth", async (original) => ({
  ...await original<typeof import("@/lib/integrations/auth")>(),
  authenticateService: async (request: Request) => {
    if (request.headers.get("authorization") !== "Bearer local-test") throw new (await import("@/lib/integrations/http")).ApiError("Unauthorized", 401);
    return { workspaceId: "ws", keyId: "test-service", scopes: ["drafts:write", "campaigns:read"] };
  },
}));
import { createDraft, getCampaign, updateDraft, updateDraftSchema } from "@/lib/integrations/campaigns";
import { callTool, listTools } from "@/lib/integrations/mcp";
import { PATCH } from "@/app/api/v1/campaigns/route";
import { contentSchema } from "@/lib/library/schema";

const context = { workspaceId: "ws", keyId: "test-service", scopes: ["drafts:write", "campaigns:read"] };
const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `update_draft_${randomBytes(6).toString("hex")}`;
let sql: Client;
const draftInput = { name: "Existing draft", instagramAccountId: "account", keywords: ["RESOURCE"],
  dmMessage: "Reviewed content", openingDmEnabled: true, openingDmMessage: "Opening", openingDmButtonLabel: "Send links",
  publicReplyEnabled: true, publicReplyMessages: ["Check your inbox", "Sent"], requireFollow: true, followPromptMessage: "Follow first",
  trackedDestinationUrl: "https://example.com/first", linkButtonLabel: "Open resource",
  secondaryDestinationUrl: "https://example.com/second", secondaryButtonLabel: "Second resource" };
async function draft() {
  return (await createDraft(context, { ...draftInput, idempotencyKey: randomBytes(12).toString("hex") })).campaignId;
}
async function snapshot(id: string) {
  return { campaign: await state.db.automation.findUniqueOrThrow({ where: { id } }),
    links: await state.db.trackedLink.findMany({ where: { automationId: id }, orderBy: { position: "asc" } }),
    revisions: await state.db.campaignRevision.findMany({ where: { automationId: id }, orderBy: { createdAt: "asc" } }) };
}
describe("update draft schema and MCP discovery", () => {
  it("preserves absent fields without schema defaults", () => {
    expect(updateDraftSchema.parse({ id: "test", expectedVersion: 1, changes: { openingDmButtonLabel: "Links" } }).changes).toEqual({ openingDmButtonLabel: "Links" });
    expect(updateDraftSchema.safeParse({ id: "test", expectedVersion: 1, changes: {} }).success).toBe(false);
    expect(updateDraftSchema.safeParse({ id: "test", expectedVersion: 0, changes: { name: "Name" } }).success).toBe(false);
    expect(updateDraftSchema.parse({ id: "test", expectedVersion: 1, changes: { goal: null } }).changes).toEqual({ goal: null });
    // Catch any future default added to contentSchema that was not removed above.
    for (const key of Object.keys(contentSchema.shape)) {
      if (key !== "openingDmButtonLabel") expect(updateDraftSchema.parse({ id: "test", expectedVersion: 1, changes: { openingDmButtonLabel: "Links" } }).changes).not.toHaveProperty(key);
    }
  });
  it("only advertises update to draft writers and marks it as a write", () => {
    expect(listTools({ ...context, scopes: ["campaigns:read"] }).map(tool => tool.name)).not.toContain("update_draft");
    expect(listTools(context).find(tool => tool.name === "update_draft")?.annotations.readOnlyHint).toBe(false);
    expect(listTools(context).find(tool => tool.name === "update_draft")?.annotations.destructiveHint).toBe(true);
  });
});

describe.skipIf(!databaseUrl)("update draft on PostgreSQL", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: databaseUrl }); await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`); await sql.query(`SET search_path TO "${schema}"`);
    const root = path.join(__dirname, "..", "prisma", "migrations");
    for (const dir of readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()) {
      await sql.query(readFileSync(path.join(root, dir, "migration.sql"), "utf8"));
    }
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: 6 }, { schema }) });
    await state.db.user.create({ data: { id: "owner", email: "draft-owner@example.test" } });
    await state.db.workspace.create({ data: { id: "ws", ownerId: "owner", name: "Local draft test" } });
    await state.db.workspace.create({ data: { id: "other", ownerId: "owner", name: "Other local test" } });
    await state.db.instagramAccount.create({ data: { id: "account", workspaceId: "ws", instagramId: "test-account", username: "test", accessToken: "DUMMY" } });
  }, 60_000);
  afterAll(async () => { await state.db?.$disconnect(); if (sql) { await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await sql.end(); } });

  it("updates only supplied content and adds one immutable key-attributed revision", async () => {
    const id = await draft(); const before = await snapshot(id);
    expect(await updateDraft(context, { id, expectedVersion: 1, changes: { openingDmButtonLabel: "Links senden" } })).toEqual({ campaignId: id, version: 2 });
    const after = await snapshot(id);
    expect(after.campaign).toEqual({ ...before.campaign, openingDmButtonLabel: "Links senden", version: 2, updatedAt: after.campaign.updatedAt });
    expect(after.links).toEqual(before.links);
    expect(after.revisions).toHaveLength(2); expect(after.revisions[0]).toEqual(before.revisions[0]);
    expect(after.revisions[1]).toMatchObject({ actorId: "test-service", snapshot: { version: 2, lifecycle: "DRAFT", isActive: false, openingDmButtonLabel: "Links senden" } });
    expect(await state.db.dmLog.count({ where: { automationId: id } })).toBe(0);
    expect(await state.db.deliveryEvent.count({ where: { automationId: id } })).toBe(0);
  });
  it("updates both link URLs and a secondary label without replacing tracking identities", async () => {
    const id = await draft(); const before = await snapshot(id);
    await updateDraft(context, { id, expectedVersion: 1, changes: { trackedDestinationUrl: "https://example.com/new-first", secondaryDestinationUrl: "https://example.com/new-second", secondaryButtonLabel: "Second" } });
    const after = await snapshot(id);
    expect(after.links.map(link => [link.id, link.slug, link.position])).toEqual(before.links.map(link => [link.id, link.slug, link.position]));
    expect((await getCampaign(context, id))).toMatchObject({ trackedDestinationUrl: "https://example.com/new-first", secondaryDestinationUrl: "https://example.com/new-second", secondaryButtonLabel: "Second" });
    expect(after.revisions[1].snapshot).toMatchObject({ trackedLinks: [{ destinationUrl: "https://example.com/new-first" }, { destinationUrl: "https://example.com/new-second", label: "Second" }] });
  });
  it("updates a secondary label alone and preserves its URL/slug", async () => {
    const id = await draft(); const before = await snapshot(id);
    await updateDraft(context, { id, expectedVersion: 1, changes: { secondaryButtonLabel: "Read more" } });
    const after = await snapshot(id);
    expect(after.links[0]).toEqual(before.links[0]);
    expect(after.links[1]).toEqual({ ...before.links[1], label: "Read more", updatedAt: after.links[1].updatedAt });
  });
  it("uses explicit null to remove URLs and leaves omitted links untouched", async () => {
    const id = await draft();
    await updateDraft(context, { id, expectedVersion: 1, changes: { secondaryDestinationUrl: null } });
    expect((await getCampaign(context, id)).secondaryDestinationUrl).toBeNull();
    await updateDraft(context, { id, expectedVersion: 2, changes: { trackedDestinationUrl: "" } });
    expect((await getCampaign(context, id)).trackedLinks).toEqual([]);
  });
  it("rejects orphan second links and missing-link labels without partial writes", async () => {
    const id = await draft(); const before = await snapshot(id);
    await expect(updateDraft(context, { id, expectedVersion: 1, changes: { trackedDestinationUrl: null } })).rejects.toMatchObject({ status: 400 });
    expect(await snapshot(id)).toEqual(before);
    await updateDraft(context, { id, expectedVersion: 1, changes: { secondaryDestinationUrl: "" } });
    const noSecondary = await snapshot(id);
    await expect(updateDraft(context, { id, expectedVersion: 2, changes: { secondaryButtonLabel: "No link" } })).rejects.toMatchObject({ status: 400 });
    expect(await snapshot(id)).toEqual(noSecondary);
  });
  it("clears nullable content and removes both links together without activation", async () => {
    const id = await draft();
    await updateDraft(context, { id, expectedVersion: 1, changes: { goal: null, openingDmEnabled: false, openingDmMessage: null, trackedDestinationUrl: null, secondaryDestinationUrl: null } });
    expect(await getCampaign(context, id)).toMatchObject({ version: 2, lifecycle: "DRAFT", isActive: false, openingDmEnabled: false, openingDmMessage: null, trackedLinks: [] });
  });
  it("validates the actual fallback for a newly inserted first link and rolls back", async () => {
    const { campaignId: id } = await createDraft(context, { name: "No links", instagramAccountId: "account", linkButtonLabel: null, idempotencyKey: randomBytes(12).toString("hex") });
    const before = await snapshot(id);
    await expect(updateDraft(context, { id, expectedVersion: 1, changes: { trackedDestinationUrl: "https://example.com/resource" } })).rejects.toMatchObject({ status: 400 });
    expect(await snapshot(id)).toEqual(before);
    await updateDraft(context, { id, expectedVersion: 1, changes: { trackedDestinationUrl: "https://example.com/resource", linkButtonLabel: "Open resource" } });
    expect(await getCampaign(context, id)).toMatchObject({ version: 2, linkButtonLabel: "Open resource", trackedDestinationUrl: "https://example.com/resource" });
  });
  it.each(["ACTIVE", "PAUSED", "ARCHIVED"])("cannot edit %s or convert it into a draft", async lifecycle => {
    const id = await draft(); await state.db.automation.update({ where: { id }, data: { lifecycle, isActive: lifecycle === "ACTIVE" } });
    const before = await snapshot(id);
    await expect(updateDraft(context, { id, expectedVersion: 1, changes: { name: "No" } })).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(id)).toEqual(before);
  });
  it("also rejects inconsistent DRAFT/isActive=true rows", async () => {
    const id = await draft(); await state.db.automation.update({ where: { id }, data: { isActive: true } });
    await expect(updateDraft(context, { id, expectedVersion: 1, changes: { name: "No" } })).rejects.toMatchObject({ status: 409 });
  });
  it("enforces write scope and workspace isolation", async () => {
    const id = await draft(); const before = await snapshot(id);
    await expect(updateDraft({ ...context, scopes: ["campaigns:read"] }, { id, expectedVersion: 1, changes: { name: "No" } })).rejects.toMatchObject({ status: 403 });
    await expect(updateDraft({ ...context, workspaceId: "other" }, { id, expectedVersion: 1, changes: { name: "No" } })).rejects.toMatchObject({ status: 404 });
    await expect(updateDraft(context, { id: "missing", expectedVersion: 1, changes: { name: "No" } })).rejects.toMatchObject({ status: 404 });
    expect(await snapshot(id)).toEqual(before);
  });
  it.each(["lifecycle", "isActive", "workspaceId", "instagramAccountId", "postId", "postUrl", "pendingNextReel", "matchAnyPost", "version", "reportShareSlug"])("rejects protected field %s", async field => {
    const id = await draft(); const before = await snapshot(id);
    await expect(updateDraft(context, { id, expectedVersion: 1, changes: { name: "Bad", [field]: "injected" } })).rejects.toMatchObject({ status: 400 });
    expect(await snapshot(id)).toEqual(before);
  });
  it.each(["openingDmButtonLabel", "followPromptButtonLabel", "linkButtonLabel", "secondaryButtonLabel"])("rejects overlong %s without writes", async field => {
    const id = await draft(); const before = await snapshot(id);
    await expect(updateDraft(context, { id, expectedVersion: 1, changes: { [field]: "a".repeat(21) } })).rejects.toMatchObject({ status: 400 });
    expect(await snapshot(id)).toEqual(before);
  });
  it("rejects invalid message/keyword/url bounds", async () => {
    const id = await draft(); const before = await snapshot(id);
    for (const changes of [{ dmMessage: "a".repeat(1001) }, { keywords: ["a".repeat(51)] }, { keywords: Array(11).fill("keyword") }, { trackedDestinationUrl: "javascript:alert(1)" }]) {
      await expect(updateDraft(context, { id, expectedVersion: 1, changes })).rejects.toMatchObject({ status: 400 });
    }
    expect(await snapshot(id)).toEqual(before);
  });
  it("rejects stale retries and simultaneous same-version edits with one revision", async () => {
    const id = await draft();
    const results = await Promise.allSettled(["First", "Second"].map(name => updateDraft(context, { id, expectedVersion: 1, changes: { name } })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.status).toBe(409);
    const after = await snapshot(id); expect(after.campaign.version).toBe(2); expect(after.revisions).toHaveLength(2);
    await expect(updateDraft(context, { id, expectedVersion: 1, changes: { name: "Retry" } })).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(id)).toEqual(after);
  });
  it("serializes content edits against concurrent activation of the same row", async () => {
    for (let i = 0; i < 5; i++) {
      const id = await draft();
      const [edit] = await Promise.allSettled([
        updateDraft(context, { id, expectedVersion: 1, changes: { dmMessage: "Changed while draft" } }),
        state.db.automation.update({ where: { id }, data: { lifecycle: "ACTIVE", isActive: true, version: { increment: 1 } } }),
      ]);
      const after = await snapshot(id);
      expect(after.campaign.lifecycle).toBe("ACTIVE"); expect(after.campaign.isActive).toBe(true);
      if (edit.status === "fulfilled") {
        expect(after.campaign.version).toBe(3); expect(after.revisions[1].snapshot).toMatchObject({ lifecycle: "DRAFT", isActive: false, version: 2 });
      } else {
        expect(edit.reason.status).toBe(409); expect(after.campaign.dmMessage).toBe(draftInput.dmMessage); expect(after.revisions).toHaveLength(1);
      }
    }
  });
  it("rejects cross-workspace link corruption without touching either workspace", async () => {
    const id = await draft(); await state.db.trackedLink.updateMany({ where: { automationId: id, position: 1 }, data: { workspaceId: "other" } });
    const before = await snapshot(id);
    await expect(updateDraft(context, { id, expectedVersion: 1, changes: { name: "No" } })).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(id)).toEqual(before);
  });
  it("rolls back campaign and links if revision persistence fails", async () => {
    const id = await draft(); const before = await snapshot(id);
    await sql.query(`CREATE FUNCTION block_revision() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'test audit failure'; END; $$ LANGUAGE plpgsql`);
    await sql.query(`CREATE TRIGGER test_revision_failure BEFORE INSERT ON "CampaignRevision" FOR EACH ROW EXECUTE FUNCTION block_revision()`);
    try {
      await expect(updateDraft(context, { id, expectedVersion: 1, changes: { name: "No", trackedDestinationUrl: "https://example.com/new" } })).rejects.toThrow();
      expect(await snapshot(id)).toEqual(before);
    } finally { await sql.query(`DROP TRIGGER test_revision_failure ON "CampaignRevision"`); await sql.query(`DROP FUNCTION block_revision()`); }
  });
  it("MCP and REST PATCH use the same guarded operation", async () => {
    const id = await draft();
    expect(await callTool(context, "update_draft", { id, expectedVersion: 1, changes: { dmMessage: "MCP edit" } })).toEqual({ campaignId: id, version: 2 });
    const body = JSON.stringify({ id, expectedVersion: 2, changes: { openingDmButtonLabel: "REST edit" } });
    const request = (authorization?: string) => new Request("http://localhost/api/v1/campaigns", { method: "PATCH", headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) }, body });
    expect((await PATCH(request())).status).toBe(401);
    const response = await PATCH(request("Bearer local-test")); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ campaignId: id, version: 3 });
    expect((await PATCH(request("Bearer local-test"))).status).toBe(409);
    expect(await state.db.campaignRevision.count({ where: { automationId: id } })).toBe(3);
  });
});
