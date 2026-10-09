import { useCallback, useEffect, useState } from "react";
import { Call, Events } from "@wailsio/runtime";

// Bound methods are called by name so the spike needs no generated bindings.
const call = (method: string, ...args: unknown[]) => Call.ByName(`main.Player.${method}`, ...args);
const player = (method: string, ...args: unknown[]) =>
  call(method, ...args).catch((err: unknown) => console.error(method, err));

type Track = { id: number; type: string; title?: string; lang?: string; selected?: boolean };
type Stamped = { ts: number };
type TimeEv = Stamped & { pos?: number; duration?: number };
type TracksEv = Stamped & { tracks: Track[] | null };
type BufferingEv = Stamped & { buffering: boolean; percent?: number; cacheSecs?: number; seeking: boolean };
type EndedEv = Stamped & { reason: string; error?: string };
type StateEv = Stamped & { name: string; value: unknown };
type Info = {
  os: string;
  mode: string;
  host: string;
  wid: number;
  widKind: string;
  clientApi: string;
  mpvVersion: string;
  embed?: Record<string, unknown>;
};

const role = new URLSearchParams(location.search).get("role") ?? "overlay";

const fmt = (t?: number) => {
  if (t === undefined || t === null || Number.isNaN(t)) return "--:--";
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// --- latency bookkeeping ------------------------------------------------------
//
// Go stamps every event with its wall clock (µs) when mpv_wait_event returned.
// We compare that with our own wall clock (timeOrigin + now, sub-ms) corrected
// by the Go-JS clock offset, estimated from the Ping round trip with the
// smallest RTT (NTP-style).

const nowMs = () => performance.timeOrigin + performance.now();
let offsetMs = 0; // Go clock minus JS clock
let samples: Record<string, number[]> = {};
let counts: Record<string, number> = {};
const sample = (name: string, ms: number) => (samples[name] ??= []).push(Math.round(ms * 1000) / 1000);
const count = (name: string) => (counts[name] = (counts[name] ?? 0) + 1);
const delivered = (name: string, ev: Stamped) => {
  count(name);
  sample(name, nowMs() - (ev.ts / 1000 - offsetMs));
};

async function calibrate(n: number) {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = nowMs();
    const goUs = (await call("Ping")) as number;
    const t1 = nowMs();
    sample("call-rtt", t1 - t0);
    if (t1 - t0 < best) {
      best = t1 - t0;
      offsetMs = goUs / 1000 - (t0 + t1) / 2;
    }
  }
}

async function flush(final: boolean) {
  await calibrate(final ? 20 : 3);
  const s = samples;
  const c = counts;
  samples = {};
  counts = {};
  await player("ReportLatency", s, c, offsetMs, final);
}

// The UI round trip: a click on play/pause until React sees the new pause state.
let clickAt = 0;

export default function App() {
  // In overlay mode the main window only hosts mpv; its webview draws nothing.
  if (role === "host") return null;
  return <Overlay />;
}

function Overlay() {
  const [time, setTime] = useState<TimeEv | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [buffering, setBuffering] = useState<BufferingEv | null>(null);
  const [ended, setEnded] = useState<EndedEv | null>(null);
  const [paused, setPaused] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  const [inputs, setInputs] = useState<string[]>([]);
  const [scrub, setScrub] = useState<number | null>(null);
  const [showInfo, setShowInfo] = useState(true);

  const logInput = useCallback((kind: string, detail: string) => {
    setInputs((xs) => [`${new Date().toLocaleTimeString()} ${kind} ${detail}`, ...xs].slice(0, 6));
    player("ReportInput", role, kind, detail);
  }, []);

  const togglePause = useCallback(() => {
    clickAt = performance.now();
    player("TogglePause");
  }, []);

  useEffect(() => {
    calibrate(20);
    player("GetInfo").then((i) => i && setInfo(i as Info));
    const offs = [
      Events.On("player:time", (e: { data: TimeEv }) => {
        delivered("player:time", e.data);
        setTime(e.data);
      }),
      Events.On("player:tracks", (e: { data: TracksEv }) => {
        delivered("player:tracks", e.data);
        setTracks(e.data.tracks ?? []);
      }),
      Events.On("player:buffering", (e: { data: BufferingEv }) => {
        delivered("player:buffering", e.data);
        if (e.data.buffering) count("buffering:true");
        setBuffering(e.data);
      }),
      Events.On("player:ended", (e: { data: EndedEv }) => {
        delivered("player:ended", e.data);
        count(`ended:${e.data.reason}`);
        setEnded(e.data);
      }),
      Events.On("player:state", (e: { data: StateEv }) => {
        delivered("player:state", e.data);
        if (e.data.name === "pause") {
          setPaused(e.data.value === true);
          if (clickAt) {
            sample("click->pause", performance.now() - clickAt);
            clickAt = 0;
          }
        }
        if (e.data.name === "path") setEnded(null);
      }),
      Events.On("spike:info", (e: { data: Info }) => setInfo(e.data)),
      Events.On("spike:flush", () => flush(true)),
    ];
    const timer = setInterval(() => flush(false), 2000);
    const onKey = (e: KeyboardEvent) => {
      logInput("keydown", e.key);
      if (e.key === " ") togglePause();
      if (e.key === "ArrowRight") player("Seek", 5, false);
      if (e.key === "ArrowLeft") player("Seek", -5, false);
      if (e.key === "i") setShowInfo((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      offs.forEach((off) => off());
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [logInput, togglePause]);

  const audio = tracks.filter((t) => t.type === "audio");
  const subs = tracks.filter((t) => t.type === "sub");
  const pos = scrub ?? time?.pos ?? 0;
  const dur = time?.duration ?? 0;

  return (
    <div
      className="stage"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) logInput("click", `stage @${e.clientX},${e.clientY}`);
      }}
    >
      <div className="badge">React overlay · {role} webview</div>

      {(buffering?.buffering || ended) && (
        <div className="status">
          {buffering?.buffering ? `Buffering… ${buffering.percent ?? 0}%` : `Ended (${ended?.reason})`}
        </div>
      )}

      {showInfo && (
        <div className="panel info">
          <h2>libmpv via cgo spike</h2>
          <dl>
            <dt>OS / mode</dt>
            <dd>
              {info?.os ?? "?"} / {info?.mode ?? "?"} / {info?.host ?? "?"}
            </dd>
            <dt>wid</dt>
            <dd>{info ? `${info.wid} (${info.widKind})` : "…"}</dd>
            <dt>libmpv</dt>
            <dd>
              {info?.mpvVersion || "…"} · API {info?.clientApi}
            </dd>
            <dt>embedded</dt>
            <dd className={info?.embed?.embedded ? "ok" : "bad"}>{String(info?.embed?.embedded ?? "…")}</dd>
            <dt>verdict</dt>
            <dd>{String(info?.embed?.verdict ?? "…")}</dd>
            <dt>buffer</dt>
            <dd>{buffering ? `${(buffering.cacheSecs ?? 0).toFixed(1)}s cached${buffering.seeking ? " · seeking" : ""}` : "…"}</dd>
          </dl>
          <h3>Input that reached this webview</h3>
          <ul className="mono">{inputs.length ? inputs.map((x, i) => <li key={i}>{x}</li>) : <li>none yet</li>}</ul>
        </div>
      )}

      <div
        className="probe"
        onMouseDown={(e) => {
          e.stopPropagation();
          logInput("click", `probe @${e.clientX},${e.clientY}`);
        }}
      >
        Click me
        <small>pointer probe</small>
      </div>

      <div className="panel controls" onMouseDown={(e) => e.stopPropagation()}>
        <button
          className="play"
          aria-label="play-pause"
          onClick={() => {
            logInput("click", "play/pause");
            togglePause();
          }}
        >
          {paused ? "▶" : "❚❚"}
        </button>
        <span className="time mono">{fmt(pos)}</span>
        <input
          className="seek"
          type="range"
          min={0}
          max={dur || 1}
          step={0.1}
          value={pos}
          onChange={(e) => setScrub(Number(e.target.value))}
          onMouseUp={() => {
            if (scrub !== null) {
              logInput("seek", scrub.toFixed(1));
              player("Seek", scrub, true);
            }
            setScrub(null);
          }}
        />
        <span className="time mono">{fmt(dur)}</span>
        <select aria-label="audio" value={String(audio.find((t) => t.selected)?.id ?? "no")} onChange={(e) => player("SetTrack", "aid", e.target.value)}>
          {audio.map((t) => (
            <option key={t.id} value={t.id}>
              Audio {t.id}
              {t.title ? ` · ${t.title}` : ""}
            </option>
          ))}
        </select>
        <select aria-label="subs" value={String(subs.find((t) => t.selected)?.id ?? "no")} onChange={(e) => player("SetTrack", "sid", e.target.value)}>
          <option value="no">Subs off</option>
          {subs.map((t) => (
            <option key={t.id} value={t.id}>
              Sub {t.id}
              {t.lang ? ` · ${t.lang}` : ""}
            </option>
          ))}
        </select>
        <button onClick={() => player("LoadLocal")}>Local</button>
        <button onClick={() => player("LoadHTTP")}>HTTP</button>
        <button onClick={() => player("LoadSlow")}>Slow</button>
      </div>
    </div>
  );
}
