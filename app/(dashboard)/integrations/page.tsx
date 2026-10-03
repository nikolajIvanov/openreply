"use client";
import { useEffect, useState } from "react";
import { SERVICE_SCOPES } from "@/lib/integrations/scopes";
type Key = { id: string; name: string; scopes: string[]; expiresAt: string; revokedAt: string | null };
export default function IntegrationsPage() {
  const [keys, setKeys] = useState<Key[]>([]);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["campaigns:read"]);
  const [token, setToken] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() { const response = await fetch("/api/integrations/keys"); const data = await response.json(); if (!response.ok) throw new Error(data.error); setKeys(data.keys); }
  useEffect(() => { void Promise.resolve().then(load).catch(e => setNotice(e.message)); }, []);
  async function create() {
    if (!window.confirm(`Zugang „${name}“ für 30 Tage anlegen? Rechte: ${scopes.join(", ")}. Wer den Schlüssel besitzt, erhält diese Rechte im Workspace.`)) return;
    setBusy(true); setToken("");
    try { const response = await fetch("/api/integrations/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, scopes, days: 30 }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setToken(data.token); await load(); }
    catch (e) { setNotice((e as Error).message); } finally { setBusy(false); }
  }
  async function revoke(key: Key) {
    setBusy(true);
    try { const response = await fetch(`/api/integrations/keys?id=${encodeURIComponent(key.id)}`, { method: "DELETE" }); if (!response.ok) throw new Error("Widerruf fehlgeschlagen"); await load(); }
    catch (e) { setNotice((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="mx-auto max-w-4xl space-y-6 p-6"><h1 className="text-2xl font-semibold">API & MCP</h1>
    <p className="text-muted">Workspace-begrenzte Service-Schlüssel. Kein Schlüssel kann Kampagnen aktivieren oder Nachrichten senden.</p>
    {notice && <p role="status">{notice}</p>}
    <section className="rounded border border-border p-4 space-y-3"><label className="block">Zugangsname<input className="w-full rounded border border-border p-2" value={name} onChange={e => setName(e.target.value)} placeholder="n8n / KI-Assistent" /></label>
      {SERVICE_SCOPES.map(scope => <label key={scope} className="block"><input type="checkbox" checked={scopes.includes(scope)} onChange={e => setScopes(current => e.target.checked ? [...current, scope] : current.filter(s => s !== scope))} /> {scope}</label>)}
      <button disabled={busy || !name || !scopes.length} onClick={create} className="rounded bg-accent text-white px-4 py-2 disabled:opacity-50">Schlüssel für 30 Tage anlegen</button>
      {token && <div role="status"><p>Nur jetzt sichtbar. Sicher speichern – nie in URL, Screenshot oder GitHub eintragen.</p><input aria-label="Neuer Service-Schlüssel" type="password" readOnly value={token} className="w-full rounded border border-border p-2" /><button onClick={() => navigator.clipboard.writeText(token)}>Kopieren</button><button className="ml-4" onClick={() => setToken("")}>Ausblenden</button></div>}
    </section>
    <section className="space-y-3">{keys.map(key => <div key={key.id} className="rounded border border-border p-4"><strong>{key.name}</strong><p className="text-sm">{key.scopes.join(", ")} · Ablauf: {new Date(key.expiresAt).toLocaleDateString("de-DE")}</p>{key.revokedAt ? <span>Widerrufen</span> : <button disabled={busy} onClick={() => revoke(key)} className="text-red-500">Widerrufen</button>}</div>)}</section>
    <section className="space-y-2 text-sm"><h2 className="font-semibold">Verbindung</h2><p>MCP: <code>/api/mcp</code> · Streamable HTTP, Bearer-Header. Für Clients, die eigene Authorization-Header unterstützen; keine OAuth-/Claude-Web-Registrierung.</p><p>API: <code>/api/v1/campaigns</code> · Ereignisse: <code>/api/v1/events</code> · Konversionen: <code>/api/v1/conversions</code>.</p><p>KI-Briefing oder Screenshot im Assistenten analysieren und mit <code>create_draft</code> übergeben. Fehlende Links offenlassen, nie erfinden. Entwurf vor Veröffentlichung hier prüfen.</p></section>
  </div>;
}
