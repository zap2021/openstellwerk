import { useEffect, useRef } from "react";

/** Wie lange das Feuerwerk läuft; danach blendet es aus. */
export const FIREWORKS_MS = 5200;

interface Spark { x: number; y: number; vx: number; vy: number; life: number; ttl: number; hue: number; size: number }

const COLORS = [45, 8, 120, 200, 285, 330];

/** Ein Feuerwerk über der ganzen Seite. Fängt keine Klicks ab und bleibt aus, wenn der Browser reduzierte Bewegung wünscht. */
export function Fireworks() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const sparks: Spark[] = [];
    const burst = () => {
      const w = window.innerWidth, h = window.innerHeight;
      const x = w * (0.15 + Math.random() * 0.7), y = h * (0.12 + Math.random() * 0.4);
      const hue = COLORS[Math.floor(Math.random() * COLORS.length)];
      const n = 70 + Math.floor(Math.random() * 30);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.2;
        const v = 1.5 + Math.random() * 4.2;
        sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, ttl: 60 + Math.random() * 40, hue: hue + Math.random() * 25 - 12, size: 1.6 + Math.random() * 1.8 });
      }
    };

    const start = performance.now();
    let nextBurst = 0, raf = 0;
    const tick = (now: number) => {
      const t = now - start;
      if (t >= nextBurst && t < FIREWORKS_MS - 1600) { burst(); nextBurst = t + 380 + Math.random() * 420; }
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.globalCompositeOperation = "lighter";
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.life++;
        if (s.life > s.ttl) { sparks.splice(i, 1); continue; }
        s.vx *= 0.985; s.vy = s.vy * 0.985 + 0.07;
        s.x += s.vx; s.y += s.vy;
        const a = 1 - s.life / s.ttl;
        ctx.fillStyle = `hsla(${s.hue}, 95%, 62%, ${a.toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size * (0.4 + a * 0.6), 0, Math.PI * 2);
        ctx.fill();
      }
      if (t < FIREWORKS_MS || sparks.length > 0) raf = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, []);
  return <canvas ref={ref} className="fireworks" aria-hidden="true" />;
}
