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
    const keyResponse = await session("/api/integrations/keys", { name: "local acceptance", scopes: ["campaigns:read", "drafts:write", "events:read", "conversions:write"] });
    assert.equal(keyResponse.status, 201, await keyResponse.clone().text());
    const { token, key } = await keyResponse.json();
    const keyList = await (await session("/api/integrations/keys")).json();
    assert.ok(!JSON.stringify(keyList).includes(token)); assert.ok(!JSON.stringify(keyList).includes("tokenHash"));
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const draft = { instagramAccountId: first.account.id, name: "Acceptance draft", dmMessage: "Hello {username}, {link}", keywords: ["LINK"],
      trackedDestinationUrl: "https://example.com/resource", idempotencyKey: `test-${suffix}`, isActive: true, lifecycle: "ACTIVE", workspaceId: second.workspace.id };
    const create = () => fetch(base + "/api/v1/campaigns", { ...post(draft), headers });
    const responses = await Promise.all([create(), create()]);
    assert.ok(responses.every(response => response.status === 201), JSON.stringify(await Promise.all(responses.map(async response => ({ status: response.status, body: await response.clone().text() })))));
    const values = await Promise.all(responses.map(response => response.json())); assert.equal(values[0].campaignId, values[1].campaignId);
    const stored = await db.automation.findUniqueOrThrow({ where: { id: values[0].campaignId } });
    assert.equal(stored.workspaceId, first.workspace.id); assert.equal(stored.lifecycle, "DRAFT"); assert.equal(stored.isActive, false);
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
    const tools = await client.listTools(); assert.equal(tools.tools.length, 5);
    const list = await client.callTool({ name: "list_campaigns", arguments: {} }); assert.ok(!list.isError);
    const mcpDraft = await client.callTool({ name: "create_draft", arguments: { ...draft, idempotencyKey: `mcp-${suffix}` } }); assert.ok(!mcpDraft.isError);
    const missingPermissionResponse = await session("/api/integrations/keys", { name: "readonly acceptance", scopes: ["campaigns:read"] });
    const readonly = await missingPermissionResponse.json();
    assert.equal((await fetch(base + "/api/v1/campaigns", { ...post(draft), headers: { ...headers, Authorization: `Bearer ${readonly.token}` } })).status, 403);
    await db.serviceKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    assert.equal((await fetch(base + "/api/v1/campaigns", { headers })).status, 401);
    console.log("PASS: actual HTTP sessions/scopes/workspace isolation, bounded JSON, concurrent draft dedupe, conversions, official MCP initialize/list/call, key revocation; no Meta send.");
  } finally {
    await client?.close();
    // Only exact user IDs created by this run in the guarded disposable DB.
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Acceptance failed"); process.exitCode = 1; });
