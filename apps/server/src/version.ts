import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The version of the installation, from the package.json at the project root (the same file the release is tagged from). */
export function readVersion(file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../package.json")): string {
  try {
    const v = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
    return typeof v === "string" && v ? v : "unbekannt";
  } catch { return "unbekannt"; }
}
