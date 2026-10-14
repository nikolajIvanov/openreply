import { createHmac } from "node:crypto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createOAuthState,
  decryptToken,
  encryptToken,
  verifyOAuthState,
} from "../lib/meta/oauth";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-with-enough-length");
  vi.stubEnv(
    "ENCRYPTION_KEY",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  );
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

function signedJson(json: string) {
  const payload = Buffer.from(json).toString("base64url");
  const signature = createHmac("sha256", process.env.NEXTAUTH_SECRET!)
    .update(payload).digest("base64url");
  return `${payload}.${signature}`;
}
function signedPayload(payload: unknown) { return signedJson(JSON.stringify(payload)); }

describe("OAuth state and token encryption", () => {
  it("round-trips encrypted tokens", () => {
    const encrypted = encryptToken("long-lived-token");
    expect(encrypted).not.toBe("long-lived-token");
    expect(decryptToken(encrypted)).toBe("long-lived-token");
  });

  it("signs and verifies Instagram OAuth state", () => {
    const state = createOAuthState("workspace_123");
    expect(verifyOAuthState(state)?.workspaceId).toBe("workspace_123");
  });

  it("rejects tampered OAuth state", () => {
    const state = createOAuthState("workspace_123");
    expect(verifyOAuthState(`${state}tampered`)).toBeNull();
  });

  it.each([undefined, null, "not-a-number", "1767268800000", true])(
    "rejects invalid signed timestamps: %s", (ts) => {
      expect(verifyOAuthState(signedPayload({ workspaceId: "workspace_123", ts }))).toBeNull();
    },
  );
  it("rejects a non-finite signed timestamp", () => {
    expect(verifyOAuthState(signedJson('{"workspaceId":"workspace_123","ts":1e309}'))).toBeNull();
  });
  it.each([undefined, null, "", "   ", 123, true, [], {}])(
    "rejects invalid signed workspace ids: %s", (workspaceId) => {
      expect(verifyOAuthState(signedPayload({ workspaceId, ts: Date.now() }))).toBeNull();
    },
  );
  it.each([null, false, [], "payload", 123])("rejects signed non-object payloads: %s", (payload) => {
    expect(verifyOAuthState(signedPayload(payload))).toBeNull();
  });
  it("rejects correctly signed malformed JSON", () => {
    expect(verifyOAuthState(signedJson("{"))).toBeNull();
  });
  it("rejects missing segments and trailing segments", () => {
    const state = createOAuthState("workspace_123");
    for (const value of [null, "", "payload", ".signature", "payload.", `${state}.extra`, `${state}.`]) {
      expect(verifyOAuthState(value)).toBeNull();
    }
  });
  it.each([
    [0, true], [600_000, true], [600_001, false], [-1, false],
  ])("enforces the inclusive state-age boundary at %d milliseconds", (age, valid) => {
    const payload = { workspaceId: "workspace_123", ts: Date.now() - age };
    expect(verifyOAuthState(signedPayload(payload))).toEqual(valid ? payload : null);
  });
  it("still requires the expected signing secret", () => {
    const state = createOAuthState("workspace_123");
    vi.stubEnv("NEXTAUTH_SECRET", "different-local-test-secret");
    expect(verifyOAuthState(state)).toBeNull();
  });
});
