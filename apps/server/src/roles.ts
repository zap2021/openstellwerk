import type { Role } from "./users.js";

/**
 * Welche Rolle eine Route mindestens braucht. Standard ist **admin**: was hier nicht ausdrücklich für Benutzer freigegeben ist,
 * bleibt der Verwaltung vorbehalten (sicher auch für Routen, die später dazukommen).
 * Fahren, Schalten, Fahrstraßen, Nothalt, Ansehen und das eigene Profil dürfen alle Angemeldeten.
 */
const USER_ROUTES: [method: string, pattern: RegExp][] = [
  ["GET", /^\/api\/(state|version|feedback|me|loco\/\d+|loco\/\d+\/mode|turnout\/\d+|turnout\/\d+\/mode|accessory\/\d+|layout|interlocking|timetable|trains|cameras|camera\/[^/]+\/feed|achievements|achievements\/me|garage\/\d+\/image|locos\/\d+\/automations|journeys|history)$/],
  ["GET", /^\/ws$/],
  ["POST", /^\/api\/(estop|accessory-estop|power|turnout\/\d+|accessory\/\d+)$/],
  ["POST", /^\/api\/loco\/\d+\/(drive|stop|estop|function\/\d+|function-group|binary-state)$/],
  ["POST", /^\/api\/interlocking\/[^/]+\/(request|release)$/],
  ["POST", /^\/api\/layout\/(route\/[^/]+\/run|tile\/[^/]+\/set)$/],
  ["POST", /^\/api\/timetable\/instances\/[^/]+\/cancel$/],
  ["POST", /^\/api\/journeys(\/[^/]+\/cancel)?$/],
  ["POST", /^\/api\/layout-rules\/[^/]+\/run$/],
  ["PUT", /^\/api\/garage\/\d+\/image$/],
  ["DELETE", /^\/api\/garage\/\d+\/image$/],
  ["PUT", /^\/api\/me$/],
  ["POST", /^\/api\/me\/password$/],
  ["POST", /^\/api\/feedback$/],
];

export function requiredRole(method: string, url: string): Role {
  const path = url.split("?")[0]!;
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  return USER_ROUTES.some(([mm, re]) => mm === m && re.test(path)) ? "user" : "admin";
}

export const allowed = (role: Role, need: Role) => role === "admin" || need === "user";
