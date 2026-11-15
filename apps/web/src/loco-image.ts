import { request } from "./api";
/** Pictures of locos: shrunk in the browser to a small JPEG, then uploaded. The server only stores them. */

export const MAX_SIDE = 256;
/** The server refuses anything above this; the browser stays below it. */
const MAX_BYTES = 200 * 1024;

/** Target size: the longest side at most `max`, aspect ratio kept, never enlarged, never below one pixel. */
export function fitSize(width: number, height: number, max = MAX_SIDE): { width: number; height: number } {
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) throw new RangeError("Bildgröße ungültig");
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Address of a loco's picture; the version makes the browser fetch a new one after an upload. */
export const imageUrl = (address: number, version: number) => `/api/garage/${address}/image?v=${version}`;

const toBlob = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));

/** Read any picture the browser can show, scale it down and encode it as JPEG (second try with lower quality if it is still big). */
export async function resizeToJpeg(file: Blob, max = MAX_SIDE): Promise<Blob> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error("Dieses Bildformat kann der Browser nicht lesen"); }
  try {
    const { width, height } = fitSize(bitmap.width, bitmap.height, max);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Das Bild konnte nicht verkleinert werden");
    ctx.fillStyle = "#fff"; // transparent areas of a PNG would turn black in a JPEG
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    for (const quality of [0.82, 0.6, 0.4]) {
      const blob = await toBlob(canvas, quality);
      if (blob && blob.size <= MAX_BYTES) return blob;
    }
    throw new Error("Das Bild bleibt auch verkleinert zu groß");
  } finally { bitmap.close(); }
}

/** Upload the picture (raw JPEG body). Errors carry the server's message, like the api() helper. */
export async function uploadLocoImage(address: number, jpeg: Blob): Promise<number> {
  const res = await request(`/api/garage/${address}/image`, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: jpeg });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) window.dispatchEvent(new Event("openstellwerk-unauthorized"));
  if (!res.ok) throw new Error(json.message ?? res.statusText);
  return json.imageVersion as number;
}
