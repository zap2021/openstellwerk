import { readFileSync, unwatchFile, watchFile } from "node:fs";
import type { Server as HttpsServer } from "node:https";

export interface TlsFiles { cert: string; key: string }

export const readTls = (f: TlsFiles) => ({ cert: readFileSync(f.cert), key: readFileSync(f.key) });

/** Both or none: half a configuration is a mistake worth stopping for. */
export function tlsFilesFromEnv(env: NodeJS.ProcessEnv): TlsFiles | undefined {
  const { TLS_CERT: cert, TLS_KEY: key } = env;
  if (!cert && !key) return undefined;
  if (!cert || !key) throw new Error("TLS_CERT und TLS_KEY müssen beide gesetzt sein");
  return { cert, key };
}

/**
 * Reload the certificate when the files change (Let's Encrypt renews every 60–90 days), so the server
 * never needs a restart for it. Polling instead of fs.watch: certbot swaps symlinks, which fs.watch misses.
 */
export function watchTls(server: HttpsServer, files: TlsFiles, onResult: (err?: Error) => void, intervalMs = 60_000) {
  let timer: NodeJS.Timeout | undefined;
  const reload = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { // cert and key are written one after the other: wait for both
      try { server.setSecureContext(readTls(files)); onResult(); } catch (e) { onResult(e as Error); }
    }, 500);
  };
  for (const f of [files.cert, files.key]) watchFile(f, { interval: intervalMs, persistent: false }, reload);
  return () => { clearTimeout(timer); for (const f of [files.cert, files.key]) unwatchFile(f, reload); };
}
