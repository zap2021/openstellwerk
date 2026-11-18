import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A small JSON file that is read once and written back with a short delay.
 * Without a path nothing is stored (tests). A failing disk must never take the server down.
 */
export class JsonFile<T> {
  /** Files with a write still waiting; flushPending() writes them now and reports failures (restore must not claim success before). */
  private static waiting = new Set<JsonFile<unknown>>();
  private timer?: NodeJS.Timeout;
  private pending?: () => T;

  constructor(private file: string | undefined, private opts: { mode?: number; delayMs?: number } = {}) {}

  /** The parsed content; undefined when there is no file (silent) or it cannot be parsed (logged). */
  read(): T | undefined {
    if (!this.file || !existsSync(this.file)) return undefined;
    try { return JSON.parse(readFileSync(this.file, "utf8")) as T; } catch (e) {
      console.error(`${path.basename(this.file)} nicht lesbar:`, (e as Error).message);
      return undefined;
    }
  }

  private exists(): boolean { return !!this.file && existsSync(this.file); }

  /**
   * Copy the file aside as `<file>.invalid-<epoch ms>.json` before a later write replaces it (best effort).
   * Called by stores that could not use what they loaded.
   */
  keepInvalid(): void {
    if (!this.exists()) return;
    const copy = `${this.file}.invalid-${Date.now()}.json`;
    try {
      copyFileSync(this.file!, copy);
      console.error(`${path.basename(this.file!)}: ungültige Datei aufbewahrt unter`, copy);
    } catch (e) {
      console.error(`${path.basename(this.file!)}: Kopie der ungültigen Datei fehlgeschlagen:`, (e as Error).message);
    }
  }

  /** Schedule a write; `get` is called when it happens, so several changes in a row cost one write. */
  write(get: () => T) {
    if (!this.file) return;
    this.pending = get;
    JsonFile.waiting.add(this as JsonFile<unknown>);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try { this.flush(); } catch (e) { console.error(`could not save ${path.basename(this.file!)}:`, (e as Error).message); }
    }, this.opts.delayMs ?? 250);
    this.timer.unref();
  }

  /** Write the scheduled content now. Throws when the disk refuses; the write then stays scheduled for the next attempt. */
  flush() {
    const get = this.pending;
    if (!this.file || !get) return;
    clearTimeout(this.timer);
    const file = this.file;
    mkdirSync(path.dirname(file), { recursive: true });
    // write next to the file and rename: a power cut (Pi!) then leaves the old file instead of half a new one
    writeFileSync(`${file}.tmp`, JSON.stringify(get(), null, 2), { mode: this.opts.mode });
    renameSync(`${file}.tmp`, file);
    if (this.pending === get) { this.pending = undefined; JsonFile.waiting.delete(this as JsonFile<unknown>); }
  }

  /** Flush every file with a waiting write. Throws one error naming all files that could not be written. */
  static flushPending() {
    const failed: string[] = [];
    for (const f of [...JsonFile.waiting]) {
      try { f.flush(); } catch (e) { failed.push(`${path.basename(f.file!)} (${(e as Error).message})`); }
    }
    if (failed.length) throw new Error(`Nicht gespeichert: ${failed.join(", ")}`);
  }
}
