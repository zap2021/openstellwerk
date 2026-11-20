import { useEffect, useMemo, useRef, useState } from "react";
import { api, type StationState } from "./api";
import { buildReport, INCLUDE_ALL, type ReportInclude } from "./feedback-report";
import { clearUsage, logUsage, recentUsage } from "./usage-log";

interface FeedbackStatus { enabled: boolean; repo: string; baseUrl: string }

/** Knopf „Problem melden“ in der Kopfzeile: öffnet den Dialog, in dem der Text samt Nutzungsinformationen vor dem Senden zu sehen ist. */
export function ReportButton({ state, version, by }: { state?: StationState; version?: string; by?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="report-btn" onClick={() => setOpen(true)} title="Einen Fehler oder Wunsch melden, mit den Angaben, wo du gerade bist" aria-haspopup="dialog">Problem melden</button>
      {open && <ReportDialog state={state} version={version} by={by} close={() => setOpen(false)} />}
    </>
  );
}

const INCLUDE_LABELS: [keyof ReportInclude, string][] = [
  ["page", "Seite und Version"],
  ["device", "Gerät: Browser, Bildschirm, Thema"],
  ["station", "Zentrale: Typ, Firmware, verbunden oder Demo (ohne Adresse)"],
  ["trail", "Verlauf der letzten Schritte (Seitenwechsel, Knöpfe, Fehlermeldungen)"],
  ["name", "Mein Name als Absender"],
];

export function ReportDialog({ state, version, by, close }: { state?: StationState; version?: string; by?: string; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<FeedbackStatus>();
  const [kind, setKind] = useState<"bug" | "idea">("bug");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [include, setInclude] = useState<ReportInclude>(INCLUDE_ALL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ number: number; url: string }>();
  const [copied, setCopied] = useState(false);
  // Der Verlauf wird beim Öffnen eingefroren: der Dialog selbst gehört nicht hinein.
  const [events] = useState(recentUsage);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    api<FeedbackStatus>("GET", "/api/feedback").then(setStatus, () => setStatus({ enabled: false, repo: "", baseUrl: "" }));
  }, []);

  const body = useMemo(() => buildReport(description, {
    route: location.hash || "#/",
    version,
    userAgent: navigator.userAgent,
    screen: `${window.innerWidth}×${window.innerHeight}`,
    theme: document.documentElement.getAttribute("data-theme") === "day" ? "Tag" : "Nacht",
    station: state ? { hw: state.hw?.hwName, firmware: state.hw?.fwVersion, connected: state.connected, demo: !!state.demo } : undefined,
    events,
    by,
  }, include), [description, include, state, version, events, by]);

  const send = async () => {
    setBusy(true); setError(undefined);
    try {
      const r = await api<{ number: number; url: string }>("POST", "/api/feedback", { kind, title, body });
      setDone(r); clearUsage(); logUsage("seite", `Meldung #${r.number} gesendet`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(`${title}\n\n${body}`); setCopied(true); } catch { setError("Kopieren nicht möglich: den Text in der Vorschau markieren und von Hand kopieren."); }
  };

  const titleOk = title.trim().length >= 5;
  return (
    <dialog ref={ref} className="report" onClose={close} onCancel={close} aria-labelledby="report-h">
      <form method="dialog" onSubmit={(e) => e.preventDefault()} className="report-form">
        <h2 id="report-h">Problem melden</h2>
        {done ? (
          <>
            <p>Danke, die Meldung ist angelegt: <a href={done.url} target="_blank" rel="noreferrer">Issue #{done.number}</a>.</p>
            <div className="row"><button type="button" className="active" onClick={close}>Schließen</button></div>
          </>
        ) : (
          <>
            <div className="row tight" role="radiogroup" aria-label="Art der Meldung">
              <label className="check"><input type="radio" name="kind" checked={kind === "bug"} onChange={() => setKind("bug")} /> Fehler</label>
              <label className="check"><input type="radio" name="kind" checked={kind === "idea"} onChange={() => setKind("idea")} /> Wunsch</label>
            </div>
            <label>Titel <input value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} placeholder="Kurz: was geht nicht?" autoFocus /></label>
            <label>Beschreibung <textarea value={description} rows={4} onChange={(e) => setDescription(e.target.value)} placeholder="Was hast du gemacht, was ist passiert, was hast du erwartet?" /></label>
            <fieldset>
              <legend>Diese Angaben gehen mit</legend>
              {INCLUDE_LABELS.map(([k, text]) => (
                <label key={k} className="check"><input type="checkbox" checked={include[k]} onChange={(e) => setInclude({ ...include, [k]: e.target.checked })} /> {text}</label>
              ))}
              <p className="hint">IP-Adressen und lange Nummern werden unkenntlich gemacht. Eingaben und Passwörter werden nie erfasst.</p>
            </fieldset>
            <label>Vorschau: genau das wird gesendet <textarea className="preview" value={body} readOnly rows={8} /></label>
            {status && !status.enabled && <p className="hint warn">Zum Senden fehlt ein Zugriffstoken (OPENSTELLWERK_UPDATE_TOKEN, siehe README). Du kannst den Text kopieren und selbst als Issue anlegen.</p>}
            {status?.enabled && <p className="hint">Wird als Issue in {status.repo} auf {status.baseUrl.replace(/^https?:\/\//, "")} angelegt.</p>}
            {error && <p className="hint warn" role="alert">{error}</p>}
            <div className="row">
              <button type="button" className="active" disabled={busy || !titleOk || !status?.enabled} onClick={() => void send()}>{busy ? "Sende …" : "Senden"}</button>
              <button type="button" onClick={() => void copy()} disabled={!titleOk}>{copied ? "Kopiert" : "Text kopieren"}</button>
              <button type="button" onClick={close}>Abbrechen</button>
            </div>
          </>
        )}
      </form>
    </dialog>
  );
}
