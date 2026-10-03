"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type Asset = { id: string; kind: string; name: string; version: number; data: Record<string, unknown> };
type Account = { id: string; username: string };
type Campaign = { id: string; name: string; trackedLinks?: { destinationUrl: string; label: string | null }[]; [key: string]: unknown };
const box = "rounded border border-border bg-surface p-3 w-full";
export default function LibraryPage() {
  const router = useRouter();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [account, setAccount] = useState("");
  const [keyword, setKeyword] = useState("LINK");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState("Hey {username}, hier ist dein gewünschter Inhalt: {link}");
  const [category, setCategory] = useState("CREATOR");
  const [templateSource, setTemplateSource] = useState("");
  const [editing, setEditing] = useState<Asset | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [draftKeys, setDraftKeys] = useState<Record<string, string>>({});
  async function load() {
    const results = await Promise.all([fetch("/api/library"), fetch("/api/instagram/accounts"), fetch("/api/automations")]);
    if (results.some(r => !r.ok)) throw new Error("Bibliothek konnte nicht geladen werden.");
    const [library, accountData, campaignData] = await Promise.all(results.map(r => r.json()));
    setAssets(library.assets); setCanManage(library.canManage);
    setAccounts(accountData.data.instagramAccounts); setCampaigns(campaignData.data);
    setAccount(current => current || accountData.data.instagramAccounts[0]?.id || "");
  }
  useEffect(() => { void Promise.resolve().then(load).catch(e => setNotice(e.message)); }, []);
  async function post(input: unknown) {
    const response = await fetch("/api/library", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Speichern fehlgeschlagen"); return data;
  }
  async function saveResource() {
    setBusy(true); setNotice("");
    try {
      await post({ action: "save", kind: "RESOURCE", name, id: editing?.id, version: editing?.version,
        data: { description, destinationUrl: url, dmMessage: message, category } });
      setEditing(null); await load(); setNotice("Ressource gespeichert. Bestehende Kampagnen und versendete Links bleiben unverändert.");
    } catch (e) { setNotice((e as Error).message); } finally { setBusy(false); }
  }
  async function saveTemplate() {
    const campaign = campaigns.find(c => c.id === templateSource); if (!campaign) return;
    setBusy(true);
    try {
      await post({ action: "save", kind: "TEMPLATE", name: campaign.name,
        data: { ...campaign, trackedDestinationUrl: campaign.trackedLinks?.[0]?.destinationUrl,
          secondaryDestinationUrl: campaign.trackedLinks?.[1]?.destinationUrl, secondaryButtonLabel: campaign.trackedLinks?.[1]?.label } });
      await load(); setNotice("Eigene Vorlage als unabhängiger Inhaltssnapshot gespeichert.");
    } catch (e) { setNotice((e as Error).message); } finally { setBusy(false); }
  }
  async function create(asset: Asset) {
    setBusy(true);
    const draftFingerprint = JSON.stringify([asset.id, asset.version, account, asset.kind === "RESOURCE" ? keyword : null]);
    const idempotencyKey = draftKeys[draftFingerprint] ?? crypto.randomUUID();
    setDraftKeys(current => ({ ...current, [draftFingerprint]: idempotencyKey }));
    try {
      const data = await post({ action: "create_draft", id: asset.id, instagramAccountId: account, keyword, idempotencyKey });
      router.push(`/campaigns/${data.campaignId}/edit`);
    } catch (e) { setNotice((e as Error).message); setBusy(false); }
  }
  function edit(asset: Asset) {
    setEditing(asset); setName(asset.name); setUrl(String(asset.data.destinationUrl ?? ""));
    setDescription(String(asset.data.description ?? "")); setMessage(String(asset.data.dmMessage ?? ""));
    setCategory(String(asset.data.category ?? "CREATOR"));
  }
  return <div className="mx-auto max-w-5xl space-y-6 p-6">
    <header><h1 className="text-2xl font-semibold">Vorlagen & Ressourcen</h1><p className="text-muted mt-2">Ein Inhalt, mehrere Videos. Jede neue Kampagne startet als Entwurf – ohne Versand.</p><Link href="/integrations" className="text-accent">API & MCP einrichten →</Link></header>
    {notice && <p role="status" className={box}>{notice}</p>}
    {canManage && <section className="grid gap-5 md:grid-cols-2">
      <div className="space-y-3 rounded border border-border p-4"><h2 className="font-semibold">{editing ? `Ressource bearbeiten · v${editing.version}` : "Neue Ressource"}</h2>
        <label className="block">Name<input className={box} value={name} onChange={e => setName(e.target.value)} /></label>
        <label className="block">Ziel-URL<input className={box} type="url" value={url} onChange={e => setUrl(e.target.value)} /></label>
        <label className="block">Beschreibung<textarea className={box} value={description} onChange={e => setDescription(e.target.value)} /></label>
        <label className="block">DM-Text<textarea className={box} value={message} onChange={e => setMessage(e.target.value)} /></label>
        <label className="block">Bereich<select className={box} value={category} onChange={e => setCategory(e.target.value)}><option value="CREATOR">Persönlicher Content</option><option value="COMPANY">Pattern & Pulse</option><option value="CLIENT">Kundenprojekt</option></select></label>
        <button disabled={busy || !name || !url} onClick={saveResource} className="rounded bg-accent px-4 py-2 text-white disabled:opacity-50">Ressource speichern</button>
        {editing && <button onClick={() => setEditing(null)} className="ml-3">Abbrechen</button>}
      </div>
      <div className="space-y-3 rounded border border-border p-4"><h2 className="font-semibold">Eigene Vorlage aus Kampagne</h2>
        <p className="text-sm text-muted">Nachrichten, Keywords und Buttons kopieren; Post-Zuordnung, Status, IDs und Statistiken bleiben draußen.</p>
        <select aria-label="Vorlagenquelle" className={box} value={templateSource} onChange={e => setTemplateSource(e.target.value)}><option value="">Kampagne wählen</option>{campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button disabled={busy || !templateSource} onClick={saveTemplate} className="rounded border border-border px-4 py-2 disabled:opacity-50">Als Vorlage speichern</button>
        <h2 className="pt-4 font-semibold">Neuen Entwurf vorbereiten</h2>
        <label className="block">Instagram-Konto<select className={box} value={account} onChange={e => setAccount(e.target.value)}>{accounts.map(a => <option key={a.id} value={a.id}>@{a.username}</option>)}</select></label>
        <label className="block">Ressourcen-Keyword<input className={box} value={keyword} onChange={e => setKeyword(e.target.value)} /></label>
        <p className="text-sm text-muted">Bei Ressourcen gilt dieses Keyword, bei Vorlagen gelten die gespeicherten Keywords. Das Video wählst du anschließend im Editor.</p>
      </div>
    </section>}
    <section className="grid gap-4 md:grid-cols-2">{assets.map(asset => <article key={asset.id} className="space-y-3 rounded border border-border p-4">
      <p className="text-xs text-muted">{asset.kind === "TEMPLATE" ? "Eigene Vorlage" : "Ressource"} · Version {asset.version}</p><h2 className="font-semibold">{asset.name}</h2>
      <p className="text-sm whitespace-pre-wrap">{String(asset.data.description ?? asset.data.dmMessage ?? "")}</p>
      {asset.kind === "RESOURCE" && <a className="text-accent break-all" href={String(asset.data.destinationUrl)} target="_blank" rel="noopener noreferrer">{String(asset.data.destinationUrl)}</a>}
      {canManage && <div className="flex gap-4"><button disabled={busy || !account} onClick={() => create(asset)} className="text-accent disabled:opacity-50">Entwurf erstellen</button>{asset.kind === "RESOURCE" && <button onClick={() => edit(asset)}>Bearbeiten</button>}</div>}
    </article>)}</section>
    {!assets.length && <p className="text-muted">Noch keine eigenen Vorlagen oder Ressourcen gespeichert.</p>}
  </div>;
}
