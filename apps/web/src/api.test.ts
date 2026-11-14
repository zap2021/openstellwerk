import { afterEach, expect, it, vi } from "vitest";
import { UNREACHABLE, api, request } from "./api";

afterEach(() => { vi.unstubAllGlobals(); });

it("says in plain words when the server cannot be reached, whatever the browser calls it", async () => {
  for (const message of ["Load failed", "Failed to fetch", "NetworkError when attempting to fetch resource."]) {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError(message); }));
    await expect(api("POST", "/api/login", { name: "admin", password: "x" })).rejects.toThrow(UNREACHABLE);
  }
});

it("keeps an aborted request an abort and passes server messages through", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("aborted", "AbortError"); }));
  await expect(request("/api/state")).rejects.toMatchObject({ name: "AbortError" });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Name oder Passwort falsch" }), { status: 401 })));
  await expect(api("POST", "/api/login", {})).rejects.toThrow("Name oder Passwort falsch");
});
