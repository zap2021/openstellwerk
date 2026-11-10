import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A small JSON file that is read once and written back with a short delay.
 * Without a path nothing is stored (tests). A failing disk must never take the server down.
 */
export class JsonFile<T> {
  private timer?: NodeJS.Timeout;

  constructor(private file: string | undefined, private opts: { mode?: number; delayMs?: number } = {}) {}

  read(): T | undefined {
    if (!this.file) return undefined;
    try { return JSON.parse(readFileSync(this.file, "utf8")) as T; } catch { return undefined; }
  }

  /** Schedule a write; `get` is called when it happens, so several changes in a row cost one write. */
  write(get: () => T) {
    if (!this.file) return;
    const file = this.file;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        // write next to the file and rename: a power cut (Pi!) then leaves the old file instead of half a new one
        writeFileSync(`${file}.tmp`, JSON.stringify(get(), null, 2), { mode: this.opts.mode });
        renameSync(`${file}.tmp`, file);
      } catch (e) {
        console.error(`could not save ${path.basename(file)}:`, (e as Error).message);
      }
    }, this.opts.delayMs ?? 250);
    this.timer.unref();
  }
}
