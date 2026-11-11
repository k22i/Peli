import { useEffect, useRef, useState } from "react";
import { call, late, shellMounted } from "./marks";

const NAV = ["Home", "Movies", "Shows", "Anime", "Library", "Settings"];

// Synthetic Home: one hero backdrop plus ROWS catalog rows of PER_ROW posters
// at TMDB's w342 size, all distinct JPEGs drawn on a canvas, so memory includes
// decoded images roughly as a real Home without virtualisation would.
const ROWS = 8;
const PER_ROW = 25;
const POSTER = { w: 342, h: 513 };
const HERO = { w: 1920, h: 1080 };

function jpeg(w: number, h: number, seed: number, label: string): Promise<string> {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const hue = (seed * 47) % 360;
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, `hsl(${hue} 60% 35%)`);
  grad.addColorStop(1, `hsl(${(hue + 90) % 360} 50% 12%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `hsla(${(hue + i * 13) % 360} 70% 60% / 0.15)`;
    const r = ((seed * 31 + i * 17) % 97) + 10;
    g.beginPath();
    g.arc(((seed * 13 + i * 71) % w), ((seed * 7 + i * 53) % h), r, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = "#fff";
  g.font = `bold ${Math.round(w / 9)}px system-ui, sans-serif`;
  g.fillText(label, w * 0.08, h * 0.9);
  return new Promise((resolve) => c.toBlob((b) => resolve(URL.createObjectURL(b!)), "image/jpeg", 0.85));
}

function Home() {
  const [hero, setHero] = useState<string>();
  const [rows, setRows] = useState<string[][]>([]);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const t0 = performance.now();
      setHero(await jpeg(HERO.w, HERO.h, 999, "Featured"));
      const out: string[][] = [];
      for (let r = 0; r < ROWS; r++) {
        const row: string[] = [];
        for (let i = 0; i < PER_ROW; i++) row.push(await jpeg(POSTER.w, POSTER.h, r * PER_ROW + i, `#${r * PER_ROW + i + 1}`));
        out.push(row);
      }
      setRows(out);
      // Wait until every image is decoded, not just fetched.
      await new Promise((r) => requestAnimationFrame(r));
      const imgs = Array.from(document.querySelectorAll<HTMLImageElement>("img"));
      await Promise.all(imgs.map((img) => img.decode().catch(() => undefined)));
      await late({ homeImages: imgs.length, homeGenMs: performance.now() - t0 });
    })();
  }, []);

  return (
    <div className="home">
      <div className="hero">{hero && <img src={hero} alt="" />}</div>
      {rows.map((row, r) => (
        <section key={r}>
          <h2>{r === 0 ? "Continue Watching" : `Catalog ${r}`}</h2>
          <div className="row">
            {row.map((src, i) => (
              <img key={i} src={src} alt="" width={171} height={256} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function App() {
  const [page, setPage] = useState<string>();
  const reported = useRef(false);

  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    shellMounted();
    call("Page").then((p) => setPage(p as string));
  }, []);

  return (
    <div className="shell">
      <nav>
        <div className="brand">Peli</div>
        {NAV.map((n, i) => (
          <a key={n} className={i === 0 ? "active" : ""} href="#">
            {n}
          </a>
        ))}
      </nav>
      <main>
        <header>
          <input placeholder="Search movies and shows" />
        </header>
        {page === "home" ? <Home /> : <p className="empty">Nothing here yet.</p>}
      </main>
    </div>
  );
}
