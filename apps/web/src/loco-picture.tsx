import { useRef, useState } from "react";
import { api } from "./api";
import { ifSure } from "./confirm";
import { imageUrl, resizeToJpeg, uploadLocoImage } from "./loco-image";

type Run = (p: Promise<unknown>) => Promise<void>;

/** The picture of the selected loco in the throttle header, with change and remove. Errors show in the page's error line. */
export function LocoPicture({ address, version, run }: { address: number; version?: number; run: Run }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const choose = (file?: File) => {
    if (!file || busy) return;
    setBusy(true);
    void run(resizeToJpeg(file).then((jpeg) => uploadLocoImage(address, jpeg))).finally(() => setBusy(false));
  };
  return (
    <div className="loco-picture">
      {version ? <img className="loco-pic" src={imageUrl(address, version)} alt={`Lok ${address}`} /> : <div className="loco-pic empty" aria-hidden="true">kein Bild</div>}
      <div className="row tight">
        <button type="button" onClick={() => input.current?.click()} disabled={busy}>{version ? "Bild ändern" : "Bild hinzufügen"}</button>
        {version ? <button type="button" onClick={() => ifSure("Bild dieser Lok entfernen?", () => run(api("DELETE", `/api/garage/${address}/image`)))} disabled={busy}>Entfernen</button> : null}
        <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
    </div>
  );
}
