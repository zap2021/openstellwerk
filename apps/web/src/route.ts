import { useCallback, useEffect, useState } from "react";

/**
 * Where the user is, kept in the URL hash so a reload stays in place:
 *   #/                       Bedienen (default)
 *   #/verwaltung[/<seite>]   Verwaltung
 *   #/anzeige                read-only second screen
 */
export type Route = { area: "operate" } | { area: "admin"; page?: string } | { area: "display" };

export function parseRoute(hash: string): Route {
  const [first, second] = hash.replace(/^#\/?/, "").split("/");
  if (first === "anzeige") return { area: "display" };
  if (first === "verwaltung") return second ? { area: "admin", page: second } : { area: "admin" };
  return { area: "operate" };
}

export function routeHash(r: Route): string {
  if (r.area === "display") return "#/anzeige";
  if (r.area === "admin") return r.page ? `#/verwaltung/${r.page}` : "#/verwaltung";
  return "#/";
}

export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((r: Route) => { window.location.hash = routeHash(r); }, []);
  return [route, go];
}
