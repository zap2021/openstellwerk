import { useState } from "react";
import { api, type StationState } from "./api";

type Run = (p: Promise<unknown>) => Promise<void>;
type Triple = { ip: string; mask: string; gateway: string };
interface NetworkInfo {
  raw: string;
  asIs: Triple;
  reversed: Triple;
  mac?: string;
  verifiedOrder?: "asIs" | "reversed";
}

/** Read-only view of the command station's network settings (maintenance channel, UDP 21106). */
export function NetworkTab({ state, run }: { state: StationState; run: Run }) {
  const [info, setInfo] = useState<NetworkInfo>();
  const [busy, setBusy] = useState(false);
  const read = () => {
    setBusy(true);
    setInfo(undefined);
    void run(api<NetworkInfo>("GET", "/api/network").then(setInfo)).finally(() => setBusy(false));
  };
  const shown = info && (info.verifiedOrder ? info[info.verifiedOrder] : info.asIs);

  return (
    <section>
      <h2>Netzwerkeinstellungen der Zentrale</h2>
      <table>
        <tbody>
          <tr><th>Verbunden über</th><td>{state.host}</td></tr>
          <tr><th>Typ</th><td>{state.hw?.hwName}</td><th>Seriennummer</th><td>{state.serial}</td></tr>
        </tbody>
      </table>
      <div className="row">
        <button disabled={busy} onClick={read}>{busy ? "Lese …" : "Einstellungen aus der Zentrale lesen"}</button>
      </div>
      {info && shown && (
        <>
          <table className="grid">
            <tbody>
              <tr><th>IP-Adresse</th><td>{shown.ip}</td></tr>
              <tr><th>Subnetz-Maske</th><td>{shown.mask}</td></tr>
              <tr><th>Standard-Gateway</th><td>{shown.gateway}</td></tr>
              {info.mac && <tr><th>MAC-Adresse</th><td>{info.mac}</td></tr>}
            </tbody>
          </table>
          {info.verifiedOrder
            ? <p className="hint">Die gelesene IP stimmt mit der Adresse überein, über die du verbunden bist – die Anzeige ist damit plausibilisiert.</p>
            : (
              <div className="error">
                Die gelesene IP passt nicht zur Verbindungsadresse ({state.host}), die Byte-Reihenfolge ist daher unbestätigt.
                Alternative Lesart: {info.reversed.ip} / {info.reversed.mask} / {info.reversed.gateway}. Rohdaten: <code>{info.raw}</code>
              </div>
            )}
        </>
      )}
      <p className="hint">
        Nur Lesen: Das Ändern der Netzwerkdaten ist bewusst nicht enthalten. Die Abfrage nutzt den Wartungsport UDP 21106 und ist an echter Hardware noch ungeprüft.
        Bei einer Verbindung über VPN kommt häufig keine Antwort, weil die Zentrale vermutlich per Broadcast antwortet – dann im Heimnetz erneut versuchen.
      </p>
    </section>
  );
}
