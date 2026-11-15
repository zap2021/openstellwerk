import { useRef, useState } from "react";
import { api } from "./api";
import { sure } from "./confirm";

type Run = (p: Promise<unknown>) => Promise<void>;
type Part = "garage" | "layout" | "cameras" | "trains" | "timetable" | "locoImages" | "automations" | "layoutRules" | "calibration" | "achievements" | "users";

const LABEL: Record<Part, string> = { garage: "Loks (Namen, Funktionsbezeichnungen, von Hand ergänzte Loks)", layout: "Gleisbild mit Blöcken und Fahrstraßen", cameras: "Kameras", trains: "Züge (ohne Standort)", timetable: "Fahrplan", locoImages: "Lok-Bilder", automations: "Automatismen der Loks", layoutRules: "Regeln der Anlage", calibration: "Kennlinien der Loks (Einmessen)", achievements: "Erfolge und Zähler", users: "Benutzer (mit Passwort-Hashes)" };
const countOf = (b: Record<string, unknown>, p: Part) =>
  p === "layout" ? (b.layout as { tiles?: unknown[] } | undefined)?.tiles?.length
  : p === "timetable" ? (b.timetable as { trips?: unknown[] } | undefined)?.trips?.length
  : p === "locoImages" ? (b.locoImages && typeof b.locoImages === "object" ? Object.keys(b.locoImages).length : undefined)
  : p === "automations" ? (b.automations ? Object.values(b.automations as Record<string, unknown[]>).reduce((n, l) => n + l.length, 0) : undefined)
  : p === "calibration" ? (b.calibration && typeof b.calibration === "object" ? Object.keys(b.calibration).length : undefined)
  : p === "users" ? (b.users as unknown[] | undefined)?.length
  : p === "achievements" ? (b.achievements ? Object.keys(((b.achievements as { anlage?: { unlocked?: object }; unlocked?: object }).anlage ?? (b.achievements as { unlocked?: object })).unlocked ?? {}).length : undefined)
  : (b[p] as unknown[] | undefined)?.length;

/** Backup of everything maintained in this application that the Z21 does not store. */
export function BackupPanel({ run }: { run: Run }) {
  const [passwords, setPasswords] = useState(false);
  const [images, setImages] = useState(true);
  const query = new URLSearchParams({ ...(passwords ? { passwords: "1" } : {}), ...(images ? {} : { images: "0" }) }).toString();
  const downloadUrl = query ? `/api/backup?${query}` : "/api/backup";
  const [file, setFile] = useState<{ name: string; backup: Record<string, unknown> }>();
  const [chosen, setChosen] = useState<Part[]>([]);
  const [done, setDone] = useState<string>();
  const input = useRef<HTMLInputElement>(null);

  const open = async (f?: File) => {
    if (!f) return;
    setDone(undefined);
    await run((async () => {
      const backup = JSON.parse(await f.text()) as Record<string, unknown>;
      if (backup?.format !== "openstellwerk-backup" && backup?.format !== "z21-web-backup") throw new Error("Das ist keine Sicherungsdatei dieser Anwendung");
      const parts = (Object.keys(LABEL) as Part[]).filter((p) => backup[p] !== undefined);
      setFile({ name: f.name, backup });
      setChosen(parts);
    })());
  };

  const restore = () => {
    if (!file) return;
    const names = chosen.map((p) => LABEL[p].split(" (")[0]).join(", ");
    if (!sure(`Folgendes wird durch den Inhalt der Datei ersetzt: ${names}.\nDer bisherige Stand dieser Teile geht verloren.`)) return;
    void run(
      api<{ restored: Partial<Record<Part, number>> }>("POST", "/api/backup/restore", { backup: file.backup, parts: chosen }).then((r) => {
        setDone(`Wiederhergestellt: ${Object.entries(r.restored).map(([k, n]) => `${LABEL[k as Part].split(" (")[0]} (${n})`).join(", ")}`);
        setFile(undefined);
      }),
    );
  };

  return (
    <div className="panel">
      <h2>Datensicherung</h2>
      <p className="hint">
        Sichert alles, was du hier pflegst und was nicht in der Z21 gespeichert ist: Loks mit Namen und Funktionsbezeichnungen (auch von Hand ergänzte),
        das Gleisbild mit Blöcken und Fahrstraßen sowie die Kameras. Fahrzustand, Weichenlagen, CVs, Uhr und Netzwerk-Einstellungen liegen in der Z21 selbst.
      </p>
      <div className="row">
        <a className="button" href={downloadUrl} download>Sicherung herunterladen</a>
        <label className="check"><input type="checkbox" checked={passwords} onChange={(e) => setPasswords(e.target.checked)} /> Kamera-Passwörter einschließen</label>
        <label className="check"><input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} /> Lok-Bilder einschließen</label>
      </div>
      <p className="hint warn">Die Sicherung enthält die Benutzerkonten mit Passwort-Hashes (keine Klartext-Passwörter). Trotzdem nur an einem sicheren Ort aufbewahren.</p>
      {passwords && <p className="hint warn">Die Datei enthält dann Passwörter im Klartext. Nur an einem sicheren Ort aufbewahren.</p>}
      <div className="row">
        <button onClick={() => input.current?.click()}>Sicherung öffnen …</button>
        <input ref={input} type="file" accept="application/json,.json" hidden onChange={(e) => { void open(e.target.files?.[0]); e.target.value = ""; }} />
        {done && <span className="hint">{done}</span>}
      </div>
      {file && (
        <div className="card">
          <strong>{file.name}</strong>
          {typeof file.backup.createdAt === "string" && <small className="hint">, erstellt {new Date(file.backup.createdAt).toLocaleString("de-DE")}</small>}
          <div className="checks">
            {(Object.keys(LABEL) as Part[]).map((p) => {
              const n = countOf(file.backup, p);
              return (
                <label key={p} className="check">
                  <input type="checkbox" disabled={n === undefined} checked={chosen.includes(p)} onChange={(e) => setChosen(e.target.checked ? [...chosen, p] : chosen.filter((x) => x !== p))} />
                  {LABEL[p]}{n === undefined ? " – nicht in der Datei" : ` – ${n} ${p === "layout" ? "Felder" : p === "timetable" ? "Fahrten" : p === "locoImages" ? "Bilder" : "Einträge"}`}
                </label>
              );
            })}
          </div>
          <div className="row tight">
            <button className="danger" disabled={!chosen.length} onClick={restore}>Auswahl wiederherstellen</button>
            <button onClick={() => setFile(undefined)}>Abbrechen</button>
          </div>
        </div>
      )}
    </div>
  );
}
