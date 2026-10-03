"use client";
import { useCallback, useEffect, useState } from "react";

type Delivery = { id: string; stage: string; status: string; campaignVersion: number; message: string | null; error: string | null; attempts: number; scheduledAt: string | null; claimedAt: string | null; sentAt: string | null; createdAt: string; updatedAt: string };
type Revision = { id: string; actorId: string | null; createdAt: string; snapshot: Record<string, unknown> };
type History = { campaign: { lifecycle: string; version: number }; delivery: Delivery[]; revisions: Revision[]; conversions: { eventType: string; count: number }[]; limits: { delivery: number; revisions: number } };
const stageNames: Record<string, string> = { TRIGGER: "Triggerauswahl", PUBLIC_REPLY: "Öffentliche Antwort", OPENING_DM: "Einstiegs-DM", FOLLOW_PROMPT: "Follow-Abfrage", FOLLOW_ACK: "Follow-Prüfbestätigung", REVEAL: "Inhalts-DM", DELIVERY_DM: "Inhalts-DM", FOLLOW_UP: "Follow-up" };
const statusNames: Record<string, string> = { SELECTED: "Ausgewählt (noch kein Versand)", PENDING: "Geplant", CLAIMED: "Versand beansprucht — Ausgang noch offen", SENT: "Versand bestätigt", FAILED: "Bestätigter Fehler", UNCONFIRMED: "Zustellung unbestätigt", SKIPPED: "Übersprungen" };
function time(value: string | null) { return value ? new Date(value).toLocaleString() : "—"; }

export default function CampaignHistory({ campaignId }: { campaignId: string }) {
  const [history, setHistory] = useState<History | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/campaigns/history?id=${encodeURIComponent(campaignId)}`, { cache: "no-store", signal });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || "Verlauf konnte nicht geladen werden.");
      if (!signal?.aborted) setHistory(payload.data);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Verlauf konnte nicht geladen werden.");
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [campaignId]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);
  return <section className="space-y-4">
    <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">Versand & Änderungsverlauf</h2><button type="button" onClick={() => void load()} disabled={loading} className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50">{loading ? "Lädt…" : "Aktualisieren"}</button></div>
    {error && <p role="alert" className="rounded border border-error/30 bg-error/10 p-3 text-sm text-error">{error}</p>}
    <p className="rounded border border-warning/30 bg-warning/5 p-3 text-xs text-muted">CLAIMED und UNCONFIRMED bedeuten: Die Nachricht könnte bereits zugestellt worden sein. Nicht blind erneut senden; erst Logs und Instagram-Verlauf manuell prüfen. Geplante Follow-ups verwenden ihren gespeicherten Inhalt und ihre Kampagnenversion.</p>
    {history && <>
      <p className="text-xs text-muted">Aktuell v{history.campaign.version} · {history.campaign.lifecycle}. Angezeigt werden die letzten {history.limits.delivery} Versandereignisse und {history.limits.revisions} gespeicherten Versionen. Frühere Zustellungen vor Einführung dieser Historie sind nicht rückwirkend vollständig erfasst.</p>
      <div className="panel rounded p-4"><h3 className="mb-2 text-sm font-semibold">Gemeldete Zielseiten-Ereignisse</h3>{history.conversions.length ? <div className="flex flex-wrap gap-3">{history.conversions.map((item) => <p key={item.eventType} className="text-sm"><span className="font-mono text-xs">{item.eventType.replace("conversion.", "")}</span>: {item.count}</p>)}</div> : <p className="text-xs text-muted">Noch keine Conversion-Ereignisse gemeldet. Linkaufrufe sind keine Downloads oder qualifizierten Anfragen.</p>}</div>
      <div className="space-y-2"><h3 className="text-sm font-semibold">Einzelergebnisse je Versandstufe</h3>{history.delivery.length ? history.delivery.map((event) => <details key={event.id} className="rounded border border-border p-3"><summary className="cursor-pointer text-sm"><span className="font-semibold">{stageNames[event.stage] ?? event.stage}</span> · {statusNames[event.status] ?? event.status} · v{event.campaignVersion}<span className="mt-1 block text-xs text-muted">{time(event.createdAt)}</span></summary><div className="mt-3 space-y-2 text-xs text-muted"><p>Geplant: {time(event.scheduledAt)} · Beansprucht: {time(event.claimedAt)} · Bestätigt: {time(event.sentAt)}</p><p>Versuche: {event.attempts} · Letzte Änderung: {time(event.updatedAt)}</p>{event.message && <div><p>{/\{username\}|\{link\}/i.test(event.message) ? "Gespeicherte Inhaltsvorlage (Platzhalter werden beim Versand gerendert):" : "Gespeicherter Versandinhalt:"}</p><p className="whitespace-pre-wrap rounded bg-surface p-2 text-foreground">{event.message}</p></div>}{event.error && <p className="break-words text-error">{event.error}</p>}</div></details>) : <p className="text-xs text-muted">Noch keine Versandstufen erfasst.</p>}</div>
      <div className="space-y-2"><h3 className="text-sm font-semibold">Gespeicherte Kampagnenversionen</h3>{history.revisions.length ? history.revisions.map((revision) => <details key={revision.id} className="rounded border border-border p-3"><summary className="cursor-pointer text-sm">v{String(revision.snapshot.version ?? "?")} · {String(revision.snapshot.lifecycle ?? "—")} · {time(revision.createdAt)}<span className="mt-1 block text-xs text-muted">{revision.actorId?.startsWith("system:") ? revision.actorId : revision.actorId ? "Änderung durch Teammitglied" : "System / unbekannt"}</span></summary><pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs text-muted">{JSON.stringify(revision.snapshot, null, 2)}</pre></details>) : <p className="text-xs text-muted">Noch keine Version gespeichert.</p>}</div>
    </>}
  </section>;
}
