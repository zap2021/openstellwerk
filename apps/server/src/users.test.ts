import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { registerAuth } from "./auth.js";
import { requiredRole } from "./roles.js";
import { hashPassword, minPasswordLength, parseUsers, UserStore, verifyPassword } from "./users.js";

describe("passwords", () => {
  it("hashes with a salt and verifies", () => {
    const a = hashPassword("geheim-123"), b = hashPassword("geheim-123");
    expect(a).not.toBe(b);
    expect(verifyPassword("geheim-123", a)).toBe(true);
    expect(verifyPassword("falsch", a)).toBe(false);
    expect(verifyPassword("x", "kaputt")).toBe(false);
  });
});

describe("UserStore", () => {
  const make = () => {
    const s = new UserStore();
    s.create({ name: "Admin", password: "adminadmin", role: "user" }); // first account becomes admin
    return s;
  };
  it("makes the first account an admin and keeps names unique", () => {
    const s = make();
    expect(s.list()[0]).toMatchObject({ name: "Admin", role: "admin" });
    expect(() => s.create({ name: "admin", password: "zweitespw1" })).toThrow(/schon/);
    expect(s.create({ name: "anna", password: "annaanna1" }).role).toBe("user");
  });
  it("never exposes the hash", () => {
    expect(JSON.stringify(make().list())).not.toContain("scrypt");
  });
  it("validates names and passwords", () => {
    const s = make();
    expect(() => s.create({ name: "a b", password: "annaanna1" })).toThrow(/Anmeldename/);
    expect(() => s.create({ name: "ben", password: "ab" })).toThrow(/mindestens 3 Zeichen/);
    expect([minPasswordLength(undefined), minPasswordLength("8"), minPasswordLength("0"), minPasswordLength("x")]).toEqual([3, 8, 3, 3]);
  });
  it("authenticates by name (any case) and refuses blocked accounts", () => {
    const s = make();
    const anna = s.create({ name: "Anna", password: "annaanna1" });
    expect(s.authenticate("anna", "annaanna1")?.id).toBe(anna.id);
    expect(s.authenticate("anna", "falsch")).toBeUndefined();
    expect(s.authenticate("niemand", "annaanna1")).toBeUndefined();
    s.update(anna.id, { active: false });
    expect(s.authenticate("anna", "annaanna1")).toBeUndefined();
  });
  it("protects the last active admin", () => {
    const s = make();
    const admin = s.list()[0]!;
    expect(() => s.remove(admin.id)).toThrow(/letzte/);
    expect(() => s.update(admin.id, { role: "user" })).toThrow(/letzte/);
    expect(() => s.update(admin.id, { active: false })).toThrow(/letzte/);
    const second = s.create({ name: "zwei", password: "zweizwei1", role: "admin" });
    expect(s.remove(second.id)).toBe(true);
  });
  it("changes a password", () => {
    const s = make();
    s.setPassword(s.list()[0]!.id, "neues-passwort");
    expect(s.authenticate("admin", "adminadmin")).toBeUndefined();
    expect(s.authenticate("admin", "neues-passwort")).toBeDefined();
  });
  it("round-trips through a file and a backup list", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "users-"));
    try {
      const file = path.join(dir, "users.json");
      const s = new UserStore(file);
      s.create({ name: "admin", password: "adminadmin" });
      s.create({ name: "anna", password: "annaanna1" });
      return new Promise<void>((resolve) => setTimeout(() => {
        expect(new UserStore(file).count()).toBe(2);
        expect(parseUsers(s.all())).toHaveLength(2);
        expect(() => parseUsers(s.all().map((u) => ({ ...u, role: "user" })))).toThrow(/Admin/);
        expect(() => parseUsers([{ id: "a", name: "x", role: "admin", hash: "nope" }])).toThrow(/Hash/);
        resolve();
      }, 400));
    } finally { setTimeout(() => rmSync(dir, { recursive: true, force: true }), 800); }
  });
});

describe("requiredRole", () => {
  it("lets users drive and look, keeps administration for admins, and defaults to admin", () => {
    for (const [m, u] of [["GET", "/api/state"], ["POST", "/api/loco/3/drive"], ["POST", "/api/loco/3/function/2"], ["POST", "/api/estop"],
      ["POST", "/api/turnout/5"], ["POST", "/api/interlocking/r1/request"], ["PUT", "/api/garage/3/image"], ["GET", "/ws"], ["GET", "/api/achievements/me"], ["POST", "/api/me/password"]] as const) {
      expect(requiredRole(m, u), `${m} ${u}`).toBe("user");
    }
    for (const [m, u] of [["PUT", "/api/layout"], ["GET", "/api/backup"], ["POST", "/api/backup/restore"], ["GET", "/api/users"], ["PUT", "/api/pom/3/5"],
      ["POST", "/api/connect"], ["PUT", "/api/locos/3/automations"], ["POST", "/api/achievements/reset"], ["GET", "/api/neue-route"], ["DELETE", "/api/trains/x"]] as const) {
      expect(requiredRole(m, u), `${m} ${u}`).toBe("admin");
    }
  });
});

describe("login with users", () => {
  const store = new UserStore();
  const admin = store.create({ name: "admin", password: "adminadmin" });
  const anna = store.create({ name: "anna", password: "annaanna1" });
  const app = Fastify();
  registerAuth(app, { users: store });
  app.get("/api/state", async (req) => ({ who: req.user?.name }));
  app.put("/api/layout", async () => ({ ok: true }));
  const ready = app.ready();
  afterAll(() => app.close());
  const login = async (name: string, password: string) => {
    await ready;
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { name, password } });
    return { res, cookie: String(res.headers["set-cookie"] ?? "").split(";")[0]! };
  };
  const as = (cookie: string, method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: object) => app.inject({ method, url, headers: { cookie }, payload });

  it("needs name and password, and says nothing about which one was wrong", async () => {
    const bad = await login("anna", "falsch");
    expect(bad.res.statusCode).toBe(401);
    expect(bad.res.json().message).toBe("Name oder Passwort falsch");
    expect((await login("niemand", "annaanna1")).res.statusCode).toBe(401);
  });
  it("lets a user drive but not administer; an admin can do both", async () => {
    const u = (await login("anna", "annaanna1")).cookie;
    expect((await as(u, "GET", "/api/state")).json()).toEqual({ who: "anna" });
    expect((await as(u, "PUT", "/api/layout")).statusCode).toBe(403);
    expect((await as(u, "GET", "/api/users")).statusCode).toBe(403);
    const a = (await login("admin", "adminadmin")).cookie;
    expect((await as(a, "PUT", "/api/layout")).statusCode).toBe(200);
    expect((await as(a, "GET", "/api/users")).json()).toHaveLength(2);
  });
  it("applies a role change and a block at once", async () => {
    const a = (await login("admin", "adminadmin")).cookie;
    const u = (await login("anna", "annaanna1")).cookie;
    await as(a, "PUT", `/api/users/${anna.id}`, { role: "admin" });
    expect((await as(u, "PUT", "/api/layout")).statusCode).toBe(200);
    await as(a, "PUT", `/api/users/${anna.id}`, { role: "user" });
    expect((await as(u, "PUT", "/api/layout")).statusCode).toBe(403);
    await as(a, "PUT", `/api/users/${anna.id}`, { active: false });
    expect((await as(u, "GET", "/api/state")).statusCode).toBe(401);
    await as(a, "PUT", `/api/users/${anna.id}`, { active: true });
  });
  it("changes the own password only with the old one and ends other sessions", async () => {
    const one = (await login("anna", "annaanna1")).cookie;
    const two = (await login("anna", "annaanna1")).cookie;
    expect((await as(one, "POST", "/api/me/password", { current: "falsch", password: "neuneuneu1" })).statusCode).toBe(403);
    expect((await as(one, "POST", "/api/me/password", { current: "annaanna1", password: "neuneuneu1" })).statusCode).toBe(200);
    expect((await as(one, "GET", "/api/state")).statusCode).toBe(200);
    expect((await as(two, "GET", "/api/state")).statusCode).toBe(401);
    expect((await login("anna", "neuneuneu1")).res.statusCode).toBe(200);
  });
  it("does not let anyone delete their own account", async () => {
    const a = (await login("admin", "adminadmin")).cookie;
    expect((await as(a, "DELETE", `/api/users/${admin.id}`)).statusCode).toBe(409);
  });
  it("reports the user in the session", async () => {
    const u = (await login("admin", "adminadmin")).cookie;
    const s = (await app.inject({ method: "GET", url: "/api/session", headers: { cookie: u } })).json();
    expect(s).toMatchObject({ required: true, authenticated: true, user: { name: "admin", role: "admin" } });
    expect(JSON.stringify(s)).not.toContain("hash");
  });
});
