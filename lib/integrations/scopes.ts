/** Client-safe constants. Never import auth/DB into client components. */
export const SERVICE_SCOPES = ["campaigns:read", "drafts:write", "events:read", "conversions:write"] as const;
