import { useState } from "react";
import type { Train } from "@z21/timetable";
import { api, type StationState } from "./api";
import { ifSure } from "./confirm";

type Run = (p: Promise<unknown>) => Promise<void>;

interface Draft { id?: string; name: string; number: string; address: number; blockId: string }
const EMPTY: Draft = { name: "", number: "", address: 0, blockId: "" };

/** Administration of trains: a train is a name, a number, a locomotive address and (optionally) a location. */
export function TrainsPage({ state, run }: { state: StationState; run: Run }) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string>();
  const timetable = state.timetable;
  if (!timetable) return <p className="hint">Die Zugverwaltung ist noch nicht verfügbar (Server zu alt oder noch nicht bereit).</p>;
  const blocks = state.layout?.blocks ?? [];
  const blockName = (id: string) => blocks.find((b) => b.id === id)?.name ?? "(Block fehlt)";
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });
  const pick = (t: Train) => { setError(undefined); setDraft({ id: t.id, name: t.name, number: t.number ?? "", address: t.address, blockId: t.location?.blockId ?? "" }); };
  const inGarage = state.garage.some((g) => g.address === draft.address);
  const problem = !draft.name.trim() ? "Name eingeben" : !(draft.address >= 1 && draft.address <= 9999) ? "Lokadresse 1–9999 eingeben" : undefined;

  /** Runs the request and shows a server error next to the form; resolves to whether it succeeded. */
  const change = async (request: () => Promise<unknown>): Promise<boolean> => {
    let ok = false;
    setError(undefined);
    await run(request().then(() => { ok = true; }, (e) => { setError((e as Error).message); }));
    return ok;
  };
  const save = async () => {
    if (problem) return;
    const body = { name: draft.name.trim(), number: draft.number.trim() || undefined, address: draft.address };
    const current = timetable.trains.find((t) => t.id === draft.id);
    await change(async () => {
      let id = draft.id;
      if (id) await api("PUT", `/api/trains/${id}`, body);
      else {
        id = (await api<Train>("POST", "/api/trains", body)).id;
        setDraft((d) => ({ ...d, id })); // a retry after a failed location update must not create a second train
      }
      if ((current?.location?.blockId ?? "") !== draft.blockId) await api("PUT", `/api/trains/${id}/location`, { blockId: draft.blockId || null });
    });
  };

  return (
    <section className="drive">
      <aside className="panel locos">
        <h2>Züge</h2>
        <ul className="loco-list">
          {timetable.trains.length === 0 && <li className="empty">Noch kein Zug angelegt.</li>}
          {timetable.trains.map((t) => (
            <li key={t.id}>
              <button className={`loco-item ${draft.id === t.id ? "active" : ""}`} onClick={() => pick(t)}>
                <span className="addr">{t.address}</span>
                <span className="meta">
                  <strong>{t.name}{t.number ? ` (${t.number})` : ""}</strong>
                  <small>{t.location ? blockName(t.location.blockId) : "kein Standort"}</small>
                  {t.location?.uncertain && <small className="warn">unsicher</small>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="panel">
        <h2>{draft.id ? "Zug bearbeiten" : "Neuer Zug"}</h2>
        <div className="form">
          <label>Name <input value={draft.name} onChange={(e) => set("name", e.target.value)} /></label>
          <label>Zugnummer <input value={draft.number} placeholder="z. B. IC 2011" onChange={(e) => set("number", e.target.value)} /></label>
          <label>Lok aus der Garage
            <select value={inGarage ? String(draft.address) : ""} onChange={(e) => set("address", Number(e.target.value) || draft.address)}>
              <option value="">– andere Adresse –</option>
              {state.garage.map((g) => <option key={g.address} value={g.address}>{g.address}{g.name ? ` – ${g.name}` : ""}</option>)}
            </select>
          </label>
          <label>Lokadresse <input type="number" min={1} max={9999} value={draft.address || ""} onChange={(e) => set("address", Number(e.target.value))} /></label>
          <label className="wide">Standort
            <select value={draft.blockId} onChange={(e) => set("blockId", e.target.value)}>
              <option value="">kein Standort</option>
              {blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              {draft.blockId && !blocks.some((b) => b.id === draft.blockId) && <option value={draft.blockId}>(Block fehlt)</option>}
            </select>
          </label>
        </div>
        {problem && <p className="hint">{problem}</p>}
        {error && <p className="hint warn">{error}</p>}
        <div className="row tight">
          <button className="active" disabled={!!problem} onClick={() => void save()}>Speichern</button>
          <button onClick={() => { setDraft(EMPTY); setError(undefined); }}>Neu</button>
          {draft.id && (
            <button className="danger" onClick={() => ifSure("Diesen Zug löschen? Auch die Fahrten dieses Zugs werden gelöscht.", () => void change(() => api("DELETE", `/api/trains/${draft.id}`)).then((ok) => { if (ok) setDraft(EMPTY); }))}>Löschen</button>
          )}
        </div>
      </div>
    </section>
  );
}
