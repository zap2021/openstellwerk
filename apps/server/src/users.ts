import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { JsonFile } from "./json-file.js";
import { setting } from "./env.js";

/* Benutzer und Rollen. Rudimentär: zwei Rollen, Passwörter als scrypt-Hash, Speicher in users.json. */

export type Role = "user" | "admin";

export interface User {
  id: string;
  /** Anmeldename, eindeutig ohne Rücksicht auf Groß-/Kleinschreibung */
  name: string;
  displayName: string;
  role: Role;
  /** `scrypt$<salt>$<hash>` (base64url) */
  hash: string;
  active: boolean;
  createdAt: number;
}

/** Was nach außen geht: nie der Hash. */
export type PublicUser = Omit<User, "hash">;
export const toPublic = ({ hash: _h, ...u }: User): PublicUser => u;

const fail = (m: string, statusCode = 400): never => { throw Object.assign(new Error(m), { statusCode }); };

/**
 * Mindestlänge neuer Passwörter. Standard 3 (Heimnetz, bequem); mit OPENSTELLWERK_MIN_PASSWORD (1..64) strenger einstellbar,
 * z. B. 8 oder mehr, wenn der Server aus dem Internet erreichbar ist.
 */
export function minPasswordLength(env: string | undefined = setting("MIN_PASSWORD")): number {
  const n = Number(env);
  return env && Number.isInteger(n) && n >= 1 && n <= 64 ? n : 3;
}
export const MIN_PASSWORD = minPasswordLength();
const NAME = /^[\p{L}\p{N}._-]{1,32}$/u;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64url")}$${scryptSync(password, salt, 32).toString("base64url")}`;
}

const SALT_BYTES = 16, HASH_BYTES = 32;
const B64URL = /^[A-Za-z0-9_-]+$/;

/** Ein Hash genau in der Form von hashPassword(): ein beschädigter (z. B. leerer) Hash darf nie jedes Passwort annehmen. */
export function isValidHash(stored: string): boolean {
  const [kind, salt, hash, ...rest] = stored.split("$");
  return kind === "scrypt" && rest.length === 0 && !!salt && !!hash && B64URL.test(salt) && B64URL.test(hash)
    && Buffer.from(salt, "base64url").length === SALT_BYTES && Buffer.from(hash, "base64url").length === HASH_BYTES;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!isValidHash(stored)) return false;
  const [, salt, hash] = stored.split("$");
  const want = Buffer.from(hash!, "base64url");
  const got = scryptSync(password, Buffer.from(salt!, "base64url"), want.length);
  return want.length === got.length && timingSafeEqual(want, got);
}

const checkPassword = (p: unknown): string => {
  const s = typeof p === "string" ? p : "";
  if (s.length < MIN_PASSWORD) fail(`Das Passwort braucht mindestens ${MIN_PASSWORD} Zeichen`);
  if (s.length > 200) fail("Das Passwort ist zu lang");
  return s;
};

const parseName = (n: unknown): string => {
  const name = typeof n === "string" ? n.trim() : "";
  if (!NAME.test(name)) fail("Anmeldename: 1–32 Zeichen aus Buchstaben, Ziffern, Punkt, Strich, Unterstrich");
  return name;
};

const parseDisplay = (d: unknown, fallback: string): string => {
  const s = typeof d === "string" ? d.trim().slice(0, 40) : "";
  return s || fallback;
};

const parseRole = (r: unknown): Role => (r === "admin" || r === "user" ? r : fail("Rolle muss „user“ oder „admin“ sein"));

/** Prüft eine Benutzerliste (Datei oder Sicherung) vollständig. Es muss mindestens ein aktiver Admin dabei sein. */
export function parseUsers(raw: unknown): User[] {
  if (!Array.isArray(raw)) fail("Benutzer: Liste erwartet");
  const ids = new Set<string>(), names = new Set<string>();
  const list = (raw as unknown[]).map((r, i): User => {
    const o = (r && typeof r === "object" ? r : fail(`Benutzer ${i + 1} ungültig`)) as Record<string, unknown>;
    const id = typeof o.id === "string" && /^[\w-]{1,40}$/.test(o.id) ? o.id : fail(`Benutzer ${i + 1}: id ungültig`);
    const name = parseName(o.name);
    if (ids.has(id)) fail(`Benutzer-id ${id} doppelt`);
    if (names.has(name.toLowerCase())) fail(`Anmeldename ${name} doppelt`);
    ids.add(id); names.add(name.toLowerCase());
    const hash = typeof o.hash === "string" && isValidHash(o.hash) ? o.hash : fail(`Benutzer ${name}: Passwort-Hash fehlt oder ist ungültig`);
    return {
      id, name, displayName: parseDisplay(o.displayName, name), role: parseRole(o.role), hash,
      active: o.active !== false, createdAt: Number.isFinite(o.createdAt) ? (o.createdAt as number) : 0,
    };
  });
  if (list.length > 0 && !list.some((u) => u.role === "admin" && u.active)) fail("Es muss mindestens einen aktiven Admin geben");
  return list;
}

export class UserStore {
  private map = new Map<string, User>();
  private file: JsonFile<User[]>;

  constructor(file?: string) {
    this.file = new JsonFile(file, { mode: 0o600 });
    const raw = this.file.read();
    if (raw !== undefined) {
      try { for (const u of parseUsers(raw)) this.map.set(u.id, u); } catch (e) {
        console.error("users.json ignoriert:", (e as Error).message);
        this.file.keepInvalid();
      }
    }
  }

  count() { return this.map.size; }
  get(id: string) { return this.map.get(id); }
  list(): PublicUser[] { return [...this.map.values()].sort((a, b) => a.name.localeCompare(b.name)).map(toPublic); }
  all(): User[] { return [...this.map.values()]; }
  find(name: string) { const n = name.trim().toLowerCase(); return [...this.map.values()].find((u) => u.name.toLowerCase() === n); }

  /** Anmeldung; liefert den Benutzer nur bei richtigem Passwort und aktivem Konto. Rechnet auch bei unbekanntem Namen (gleiche Zeit). */
  authenticate(name: string, password: string): User | undefined {
    const u = this.find(name);
    const ok = verifyPassword(password, u?.hash ?? DUMMY);
    return u && u.active && ok ? u : undefined;
  }

  create(input: { name?: unknown; displayName?: unknown; role?: unknown; password?: unknown }): PublicUser {
    const name = parseName(input.name);
    if (this.find(name)) fail("Diesen Anmeldenamen gibt es schon", 409);
    // the first account must be able to administer
    const u: User = {
      id: randomBytes(9).toString("base64url"), name, displayName: parseDisplay(input.displayName, name),
      role: this.map.size === 0 ? "admin" : parseRole(input.role ?? "user"), hash: hashPassword(checkPassword(input.password)), active: true, createdAt: Date.now(),
    };
    this.map.set(u.id, u);
    this.persist();
    return toPublic(u);
  }

  update(id: string, patch: { displayName?: unknown; role?: unknown; active?: unknown }): PublicUser {
    const cur = this.map.get(id) ?? fail("Benutzer nicht gefunden", 404);
    const next: User = { ...cur! };
    if (patch.displayName !== undefined) next.displayName = parseDisplay(patch.displayName, cur!.name);
    if (patch.role !== undefined) next.role = parseRole(patch.role);
    if (patch.active !== undefined) next.active = patch.active === true;
    this.guardLastAdmin(cur!, next);
    this.map.set(id, next);
    this.persist();
    return toPublic(next);
  }

  setPassword(id: string, password: unknown) {
    const cur = this.map.get(id) ?? fail("Benutzer nicht gefunden", 404);
    this.map.set(id, { ...cur!, hash: hashPassword(checkPassword(password)) });
    this.persist();
  }

  remove(id: string): boolean {
    const cur = this.map.get(id);
    if (!cur) return false;
    this.guardLastAdmin(cur, undefined);
    this.map.delete(id);
    this.persist();
    return true;
  }

  /** Sicherung wiederherstellen; `list` kommt von parseUsers. */
  replaceAll(list: User[]) {
    this.map = new Map(list.map((u) => [u.id, u]));
    this.persist();
  }

  /** Der letzte aktive Admin darf weder gelöscht noch gesperrt noch herabgestuft werden. */
  private guardLastAdmin(cur: User, next: User | undefined) {
    const wasAdmin = cur.role === "admin" && cur.active;
    const stays = !!next && next.role === "admin" && next.active;
    if (wasAdmin && !stays && ![...this.map.values()].some((u) => u.id !== cur.id && u.role === "admin" && u.active)) {
      fail("Das ist der letzte aktive Admin", 409);
    }
  }

  private persist() { this.file.write(() => this.all()); }
}

const DUMMY = hashPassword("dummy-password-for-timing");
