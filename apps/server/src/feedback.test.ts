import { describe, expect, it } from "vitest";
import { BODY_MAX, FeedbackService, MIN_GAP_MS } from "./feedback.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(o: { token?: string; issue?: () => Response | Promise<Response>; labels?: unknown } = {}) {
  const requests: { url: string; method: string; auth?: string; body?: Record<string, unknown> }[] = [];
  let t = 1_000_000;
  const service = new FeedbackService({ baseUrl: "https://git.example/", repo: "me/proj", token: "token" in o ? o.token : "geheim" }, {
    now: () => t,
    fetch: (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      requests.push({ url, method: init?.method ?? "GET", auth: init?.headers?.authorization, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url.includes("/labels")) return json(200, o.labels ?? [{ id: 7, name: "bug" }, { id: 9, name: "enhancement" }]);
      return o.issue ? o.issue() : json(201, { number: 42, html_url: "https://git.example/me/proj/issues/42" });
    }) as unknown as typeof fetch,
  });
  return { service, requests, tick: (ms: number) => { t += ms; } };
}

describe("FeedbackService", () => {
  it("meldet ohne Token, ohne es preiszugeben", () => {
    const { service } = setup({ token: undefined });
    expect(service.status()).toEqual({ enabled: false, repo: "me/proj", baseUrl: "https://git.example" });
    expect(JSON.stringify(service.status())).not.toContain("geheim");
    return expect(service.submit({ title: "Ein Titel", body: "Text" })).rejects.toThrow(/Zugriffstoken/);
  });

  it("legt ein Issue mit Token und Label an", async () => {
    const { service, requests } = setup();
    expect(service.status().enabled).toBe(true);
    const r = await service.submit({ kind: "bug", title: "  Knopf   tut nichts ", body: "Beschreibung", by: "u1" });
    expect(r).toEqual({ number: 42, url: "https://git.example/me/proj/issues/42" });
    const post = requests.find((q) => q.method === "POST")!;
    expect(post.url).toBe("https://git.example/api/v1/repos/me/proj/issues");
    expect(post.auth).toBe("token geheim");
    expect(post.body).toEqual({ title: "Knopf tut nichts", body: "Beschreibung", labels: [7] });
  });

  it("nimmt für Wünsche das Label enhancement und kommt auch ohne Label zurecht", async () => {
    const a = setup();
    await a.service.submit({ kind: "idea", title: "Gute Idee hier", body: "x" });
    expect(a.requests.find((q) => q.method === "POST")!.body!.labels).toEqual([9]);
    const b = setup({ labels: [] });
    await b.service.submit({ kind: "bug", title: "Ohne Label hier", body: "x" });
    expect(b.requests.find((q) => q.method === "POST")!.body).not.toHaveProperty("labels");
  });

  it("prüft Titel und Text", async () => {
    const { service } = setup();
    await expect(service.submit({ title: "kurz", body: "x" })).rejects.toThrow(/Titel ist zu kurz/);
    await expect(service.submit({ title: "Ein Titel", body: " " })).rejects.toThrow(/Beschreibung fehlt/);
    await expect(service.submit({ title: "Ein Titel", body: "x".repeat(BODY_MAX + 1) })).rejects.toThrow(/zu lang/);
    await expect(service.submit({ title: "x".repeat(200), body: "x" })).rejects.toThrow(/Titel ist zu lang/);
  });

  it("bremst schnelle Wiederholungen je Person, andere dürfen weiter", async () => {
    const { service, tick } = setup();
    await service.submit({ title: "Erste Meldung", body: "x", by: "u1" });
    await expect(service.submit({ title: "Zweite Meldung", body: "x", by: "u1" })).rejects.toMatchObject({ statusCode: 429 });
    await service.submit({ title: "Andere Person", body: "x", by: "u2" });
    tick(MIN_GAP_MS + 1);
    await service.submit({ title: "Wieder erlaubt", body: "x", by: "u1" });
  });

  it("erklärt Fehler der Plattform und zählt sie nicht als Meldung", async () => {
    for (const [status, re] of [[401, /lehnt das Zugriffstoken ab/], [403, /keine Issues anlegen/], [404, /nicht gefunden/], [500, /HTTP 500/]] as const) {
      const { service } = setup({ issue: () => json(status, { message: "nein" }) });
      await expect(service.submit({ title: "Ein Titel", body: "x", by: "u1" })).rejects.toThrow(re);
      // der Fehlversuch sperrt die Wiederholung nicht
      await expect(service.submit({ title: "Ein Titel", body: "x", by: "u1" })).rejects.toThrow(re);
    }
    const { service } = setup({ issue: () => { throw new Error("offline"); } });
    await expect(service.submit({ title: "Ein Titel", body: "x" })).rejects.toThrow(/nicht erreichbar/);
  });
});
