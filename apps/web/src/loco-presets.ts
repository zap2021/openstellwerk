/**
 * Funktionsbelegungen bekannter Modelle als Vorlage für die Funktionsbeschriftung (F0–F31, Namen höchstens 24 Zeichen).
 * Quelle sind die Anleitungen bzw. Funktionsdatenblätter der Hersteller (Piko, Märklin/Trix, Roco); die Artikelnummer steht in `article`.
 * Die Tabellen gelten für die ab Werk eingebauten Sound-Decoder in der Auslieferungsbelegung, ein nachgerüsteter Decoder kann anders belegt sein.
 */
export interface LocoPreset {
  id: string;
  /** Hersteller und Artikelnummer, z. B. „Piko 52322“ */
  article: string;
  /** Modellname für Auswahl und als Vorschlag für den Loknamen */
  name: string;
  /** Hinweis zur Quelle bzw. zu Besonderheiten, wird unter der Auswahl angezeigt */
  note?: string;
  functions: Record<number, string>;
}

const list = (names: string[]): Record<number, string> => Object.fromEntries(names.map((n, i) => [i, n]));

export const LOCO_PRESETS: LocoPreset[] = [
  {
    id: "piko-52322", article: "Piko 52322", name: "V 100 (BR 211)",
    note: "Piko-Anleitung 52322 (PSD XP 5.1 Sound).",
    functions: list([
      "Licht", "Fahrgeräusch", "Fahrgeräusch Last", "Führerstandslicht", "Lokführergruß", "Zugbel. Lok zieht", "Zugbel. Lok schiebt", "Rangiergang",
      "Lautstärke", "Kuppeln", "Horn", "Hilfsdiesel", "Heizung", "Glocke", "Handbremse", "Sanden",
      "Zusatzbremse", "Schnellbremsung", "Funk 1", "Funk 2", "Funk 3", "Durchsage 1", "Durchsage 2", "Durchsage 3",
      "Schaffnerpfiff", "Ton aus",
    ]),
  },
  {
    id: "piko-52732", article: "Piko 52732", name: "VT 98 Schienenbus",
    note: "Allgemeine Piko-Anleitung für den Schienenbus BR 798 (PSD 4.1 Sound). F4 gibt es nur je nach Ausführung.",
    functions: list([
      "Licht vorn", "Motorsound", "Innenbeleuchtung", "Führerstandstür", "Zugzielanzeiger", "Rangiergang", "Lokführergruß", "Handbremse",
      "Vorwärmgerät", "Bremse an/lösen", "Druckluftpfeife kurz", "Druckluftpfeife lang", "Führerstandsfenster", "Druckluft ablassen", "Notbremse", "Schaffnerpfiff",
      "Sanden", "Kuppeln", "Bremsgeräusch aus", "Schienenstöße", "Kurvenquietschen", "Zugbel. Lok zieht", "Zugbel. Lok schiebt", "Soundfader (Tunnel)",
    ]),
  },
  {
    id: "piko-52602", article: "Piko 52602", name: "V 200 (BR 221)",
    note: "52602 hat ab Werk keinen Sound-Decoder. Belegung des Piko-V-200-Sound-Decoders (Anleitung 52901); bitte mit dem eingebauten Decoder abgleichen.",
    functions: list([
      "Licht vorn", "Motorsound", "Horn", "Kraftstoffpumpe", "Führerstandslicht", "Fernlicht", "Maschinenraumlicht", "Rangiergang",
      "Handbremse", "Scheibenwischer", "Führerstandstür", "Führerstandsfenster", "Maschinenraumtür", "Richtungswender", "Druckluft ablassen", "Kuppeln",
      "Zugbremse", "Schnellbremsung", "Schaffnerpfiff", "Lüftergitter", "Totmannschalter", "Funk", "Sanden", "Kurvenquietschen",
      "Schienenstöße", "Zugbel. Lok schiebt", "Zugbel. Lok zieht", "Lautstärke", "Soundfader (Tunnel)",
    ]),
  },
  {
    id: "piko-51813", article: "Piko 51813", name: "E 10.12",
    note: "Piko-Anleitung 51813 (PSD XP 5.1 Sound). Nach Herstellerangabe sind Kurvenquietschen und Lautstärke nur in der AC-Ausführung vorgesehen.",
    functions: list([
      "Spitzenlicht", "Motorsound", "Horn hoch", "Horn tief", "Führerstandslicht", "Zugbel. Lok zieht", "Zugbel. Lok schiebt", "Rangiergang",
      "Maschinenraumlicht", "Stromabnehmer", "Führerstandstür", "Führerstandsfenster", "Kuppeln", "Handbremse", "Zugbremse", "Zusatzbremse",
      "Durchsage 1", "Schaffnerpfiff", "Fahrmotorlüfter", "Bremswiderstandslüfter", "Ölkühlerlüfter", "Kompressor", "Hilfskompressor", "Sanden",
      "Zugheizung", "Schienenstöße", "Kurvenquietschen", "Lautstärke", "Ton aus",
    ]),
  },
  {
    id: "trix-22875", article: "Trix 22875", name: "BR 78",
    note: "Trix-Anleitung 22875 (Funktionen ab F16 setzen bei der Mobile Station 2 Softwareversion 3.55 voraus).",
    functions: list([
      "Spitzensignal", "Betriebsgeräusch", "Lokpfeife lang", "Rauchgenerator", "ABV aus", "Führerstandslicht", "Spitzensignal hinten aus", "Glocke",
      "Schlusslicht rot", "Bremsenquietschen aus", "Kohle schaufeln", "Schaffnerpfiff", "Dampf ablassen", "Rangierlicht + -gang", "Rangierpfiff", "Luftpumpe",
      "Wasserpumpe", "Injektor", "Sanden", "Sicherheitsventil", "Kipprost", "Generator", "Wasser nachfüllen", "Sand nachfüllen",
      "Kohle fassen",
    ]),
  },
  {
    id: "roco-70318", article: "Roco 70318", name: "BR 86 (086 400-9)",
    note: "Roco-Funktionsdatenblatt 70318 (ZIMO MX645P22). Viele Geräusche laufen nur bei eingeschaltetem Fahrgeräusch (F1).",
    functions: list([
      "Licht", "Fahrgeräusch", "Pfeife kurz", "Pfeife lang", "Schaffnerpfiff", "An-/Abkuppeln", "Rangiergang", "Kurvenquietschen",
      "Leerlauf", "Führerstand (Halt)", "Speisepumpe", "Kohle schaufeln", "Injektor", "Entwässern", "Lautlos", "Lichtmaschine",
      "Hilfsbläser", "Abschlammen", "Pfeife sehr kurz", "Wasserfassen", "Sanden", "Luftpumpe schnell", "Luftpumpe langsam", "Handbremse",
      "Glocke", "Lautstärke lauter", "Lautstärke leiser",
    ]),
  },
];

export function findPreset(id: string): LocoPreset | undefined {
  return LOCO_PRESETS.find((p) => p.id === id);
}
