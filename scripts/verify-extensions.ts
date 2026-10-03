/** Real HTTP + official MCP client acceptance, disposable localhost fixtures only.
 * Start Next with local DATABASE_URL/REDIS_URL/NEXTAUTH_URL and run with matching
 * TEST_DATABASE_URL, TEST_BASE_URL. Never points to the production database. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  const dbUrl = process.env.TEST_DATABASE_URL ?? "";
  const base = process.env.TEST_BASE_URL ?? "";
  if (!dbUrl || !base || !["localhost", "127.0.0.1"].includes(new URL(dbUrl).hostname) ||
      !["localhost", "127.0.0.1"].includes(new URL(base).hostname)) throw new Error("Local disposable database and server required");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl }) });
  const suffix = randomBytes(8).toString("hex");
  const users: string[] = [];
  let client: Client | undefined;
  const post = (input: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  try {
    async function fixture(index: number) {
      const user = await db.user.create({ data: { email: `extensions-${suffix}-${index}@example.test` } }); users.push(user.id);
      const workspace = await db.workspace.create({ data: { ownerId: user.id, name: `extensions test ${suffix}`, members: { create: { userId: user.id, role: "OWNER" } } } });
      const account = await db.instagramAccount.create({ data: { workspaceId: workspace.id, username: `extensions-${suffix}-${index}`, instagramId: `${suffix}-${index}`, accessToken: "LOCAL-TEST-NOT-A-REAL-TOKEN" } });
      const sessionToken = randomBytes(32).toString("base64url");
      await db.session.create({ data: { userId: user.id, sessionToken, expires: new Date(Date.now() + 3600000) } });
      return { workspace, account, cookie: `authjs.session-token=${sessionToken}` };
    }
    const first = await fixture(1), second = await fixture(2);
    async function session(path: string, input?: unknown, cookie = first.cookie, origin = base) {
      const init = input === undefined ? {} : post(input);
      return fetch(base + path, { ...init, headers: { ...(input === undefined ? {} : { "Content-Type": "application/json" }), Cookie: cookie, Origin: origin } });
    }
    assert.equal((await session("/api/integrations/keys", { name: "bad origin", scopes: ["campaigns:read"] }, first.cookie, "https://evil.example")).status, 403);
    const pageResponse = await session("/integrations");
    assert.equal(pageResponse.status, 200);
    const pageHtml = await pageResponse.text();
    assert.ok(pageHtml.includes("update_draft")); assert.ok(pageHtml.includes("expectedVersion"));
    for (const days of [30, 60, 90]) assert.ok(pageHtml.includes(`value="${days}"`));
    assert.match(pageHtml, /<option[^>]*value="30"[^>]*selected=""/);
    const keyResponse = await session("/api/integrations/keys", { name: "local acceptance", scopes: ["campaigns:read", "drafts:write", "events:read", "conversions:write"] });
    assert.equal(keyResponse.status, 201, await keyResponse.clone().text());
    const { token, key } = await keyResponse.json();
    const originalKey = await db.serviceKey.findUniqueOrThrow({ where: { id: key.id } });
    for (const days of [30, 60, 90]) {
      const started = Date.now();
      const response = await session("/api/integrations/keys", { name: `local ${days} days`, scopes: ["campaigns:read"], days });
      assert.equal(response.status, 201);
      const created = await response.json();
      const expiry = new Date(created.key.expiresAt).getTime();
      assert.ok(expiry >= started + days * 86400000 && expiry <= Date.now() + days * 86400000);
    }
    for (const days of [0, 91, 365, 30.5]) {
      assert.equal((await session("/api/integrations/keys", { name: "invalid days", scopes: ["campaigns:read"], days })).status, 400);
    }
    assert.deepEqual(await db.serviceKey.findUniqueOrThrow({ where: { id: key.id } }), originalKey);
    const keyList = await (await session("/api/integrations/keys")).json();
    assert.ok(!JSON.stringify(keyList).includes(token)); assert.ok(!JSON.stringify(keyList).includes("tokenHash"));
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const draft = { instagramAccountId: first.account.id, name: "Acceptance draft", dmMessage: "Hello {username}, {link}", keywords: ["LINK"],
      trackedDestinationUrl: "https://example.com/resource", linkButtonLabel: "Open resource", secondaryDestinationUrl: "https://example.com/second", secondaryButtonLabel: "Second",
      openingDmEnabled: true, openingDmMessage: "Confirm", openingDmButtonLabel: "Yes",
      idempotencyKey: `test-${suffix}`, isActive: true, lifecycle: "ACTIVE", workspaceId: second.workspace.id };
    const create = () => fetch(base + "/api/v1/campaigns", { ...post(draft), headers });
    const responses = await Promise.all([create(), create()]);
    assert.ok(responses.every(response => response.status === 201), JSON.stringify(await Promise.all(responses.map(async response => ({ status: response.status, body: await response.clone().text() })))));
    const values = await Promise.all(responses.map(response => response.json())); assert.equal(values[0].campaignId, values[1].campaignId);
    const stored = await db.automation.findUniqueOrThrow({ where: { id: values[0].campaignId } });
    assert.equal(stored.workspaceId, first.workspace.id); assert.equal(stored.lifecycle, "DRAFT"); assert.equal(stored.isActive, false);
    const detailResponse = await fetch(base + `/api/v1/campaigns?id=${stored.id}`, { headers });
    assert.equal(detailResponse.status, 200);
    const { data: detail } = await detailResponse.json();
    assert.equal(detail.trackedDestinationUrl, draft.trackedDestinationUrl);
    assert.equal(detail.secondaryDestinationUrl, draft.secondaryDestinationUrl);
    assert.equal(detail.openingDmMessage, "Confirm"); assert.equal(detail.version, 1);
    assert.equal(detail.trackedLinks.length, 2);
    for (const field of ["accessToken", "reportShareSlug", "instagramAccount", "dmLogs", "deliveryEvents"]) assert.ok(!(field in detail));
    const foreign = await fetch(base + "/api/v1/campaigns", { ...post({ ...draft, instagramAccountId: second.account.id, idempotencyKey: `foreign-${suffix}` }), headers }); assert.equal(foreign.status, 404);
    assert.equal((await fetch(base + "/api/v1/campaigns", { ...post({ ...draft, dmMessage: "Changed" }), headers })).status, 409);
    assert.equal((await fetch(base + "/api/v1/campaigns", { method: "POST", headers, body: "not json" })).status, 400);
    assert.equal((await fetch(base + "/api/v1/campaigns", { method: "POST", headers, body: JSON.stringify({ padding: "x".repeat(66000) }) })).status, 413);
    const foreignList = await (await session("/api/library", undefined, second.cookie)).json(); assert.deepEqual(foreignList.assets, []);
    const resourceResponse = await session("/api/library", { action: "save", kind: "RESOURCE", name: "Test resource", data: { destinationUrl: "https://example.com/resource", dmMessage: "Your resource", secret: "discard" } }); assert.equal(resourceResponse.status, 201);
    const resource = (await resourceResponse.json()).asset; assert.ok(!JSON.stringify(resource.data).includes("discard"));
    assert.equal((await session("/api/library", { action: "save", kind: "RESOURCE", name: "Other", id: resource.id, version: resource.version, data: { destinationUrl: "https://example.com" } }, second.cookie)).status, 409);
    const conversion = { campaignId: stored.id, externalId: `conversion-${suffix}`, type: "form_completed" };
    for (let i = 0; i < 2; i++) assert.ok([200, 201].includes((await fetch(base + "/api/v1/conversions", { ...post(conversion), headers })).status));
    assert.equal(await db.integrationEvent.count({ where: { workspaceId: first.workspace.id, eventType: "conversion.form_completed" } }), 1);
    client = new Client({ name: "openreply-local-review", version: "1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/api/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const tools = await client.listTools(); assert.equal(tools.tools.length, 6);
    const list = await client.callTool({ name: "list_campaigns", arguments: {} }); assert.ok(!list.isError);
    const mcpDetail = await client.callTool({ name: "get_campaign", arguments: { id: stored.id } });
    assert.ok(!mcpDetail.isError);
    const content = mcpDetail.content as Array<{ type: string; text?: string }>;
    assert.deepEqual(JSON.parse(content[0].text!), detail);
    const mcpDraft = await client.callTool({ name: "create_draft", arguments: { ...draft, idempotencyKey: `mcp-${suffix}` } }); assert.ok(!mcpDraft.isError);
    const patch = (input: unknown, authorization = headers.Authorization) => fetch(base + "/api/v1/campaigns", {
      method: "PATCH", headers: { ...headers, Authorization: authorization }, body: JSON.stringify(input),
    });
    const edit = { id: stored.id, expectedVersion: 1, changes: { openingDmButtonLabel: "Send resources" } };
    const edited = await patch(edit); assert.equal(edited.status, 200); assert.deepEqual(await edited.json(), { campaignId: stored.id, version: 2 });
    assert.equal((await patch(edit)).status, 409);
    assert.equal((await patch({ id: stored.id, expectedVersion: 2, changes: { lifecycle: "ACTIVE" } })).status, 400);
    const mcpEdit = await client.callTool({ name: "update_draft", arguments: { id: stored.id, expectedVersion: 2, changes: { secondaryButtonLabel: "More resources" } } });
    assert.ok(!mcpEdit.isError);
    const editedCampaign = await db.automation.findUniqueOrThrow({ where: { id: stored.id } });
    assert.equal(editedCampaign.version, 3); assert.equal(editedCampaign.dmMessage, stored.dmMessage);
    assert.equal(editedCampaign.openingDmEnabled, true); assert.equal(editedCampaign.lifecycle, "DRAFT"); assert.equal(editedCampaign.isActive, false);
    const revisions = await db.campaignRevision.findMany({ where: { automationId: stored.id }, orderBy: { createdAt: "asc" } });
    assert.equal(revisions.length, 3); assert.equal(revisions[2].actorId, key.id);
    assert.equal(await db.dmLog.count({ where: { automationId: stored.id } }), 0);
    assert.equal(await db.deliveryEvent.count({ where: { automationId: stored.id } }), 0);
    assert.equal((await patch({ id: stored.id, expectedVersion: 3, changes: { openingDmButtonLabel: "x".repeat(21) } })).status, 400);
    const foreignKeyResponse = await session("/api/integrations/keys", { name: "foreign writer", scopes: ["drafts:write"] }, second.cookie);
    assert.equal(foreignKeyResponse.status, 201); const foreignKey = await foreignKeyResponse.json();
    assert.equal((await patch({ id: stored.id, expectedVersion: 3, changes: { name: "Foreign" } }, `Bearer ${foreignKey.token}`)).status, 404);
    await db.automation.update({ where: { id: stored.id }, data: { lifecycle: "PAUSED" } });
    assert.equal((await patch({ id: stored.id, expectedVersion: 3, changes: { name: "Paused" } })).status, 409);
    await db.automation.update({ where: { id: stored.id }, data: { lifecycle: "DRAFT" } });
    assert.equal((await db.automation.findUniqueOrThrow({ where: { id: stored.id } })).version, 3);
    const missingPermissionResponse = await session("/api/integrations/keys", { name: "readonly acceptance", scopes: ["campaigns:read"] });
    const readonly = await missingPermissionResponse.json();
    assert.equal((await fetch(base + "/api/v1/campaigns", { ...post(draft), headers: { ...headers, Authorization: `Bearer ${readonly.token}` } })).status, 403);
    assert.equal((await patch({ id: stored.id, expectedVersion: 3, changes: { name: "Forbidden" } }, `Bearer ${readonly.token}`)).status, 403);
    await db.serviceKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    assert.equal((await fetch(base + "/api/v1/campaigns", { headers })).status, 401);
    assert.equal((await patch({ id: stored.id, expectedVersion: 3, changes: { name: "Revoked" } })).status, 401);
    console.log("PASS: actual HTTP sessions/scopes/workspace isolation, 30/60/90-day keys and unchanged existing keys, bounded JSON, concurrent draft dedupe, safe API/MCP details, version-guarded REST/MCP draft updates and history, conversions, official MCP initialize/list/call, key revocation; no Meta send.");
  } finally {
    await client?.close();
    // Only exact user IDs created by this run in the guarded disposable DB.
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Acceptance failed"); process.exitCode = 1; });
