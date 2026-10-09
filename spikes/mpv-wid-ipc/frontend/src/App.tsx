import { useCallback, useEffect, useRef, useState } from "react";
import { Call, Events } from "@wailsio/runtime";

// Bound methods are called by name so the spike needs no generated bindings.
const player = (method: string, ...args: unknown[]) =>
  Call.ByName(`main.Player.${method}`, ...args).catch((err: unknown) => console.error(method, err));

type Track = { id: number; type: string; title?: string; lang?: string; codec?: string; selected?: boolean };
type Props = {
  "time-pos"?: number;
  duration?: number;
  pause?: boolean;
  "track-list"?: Track[];
  path?: string;
  "hwdec-current"?: string;
};
type Info = {
  os: string;
  mode: string;
  wid: number;
  widKind: string;
  mpvVersion: string;
  endpoint: string;
  embed?: Record<string, unknown>;
};

const role = new URLSearchParams(location.search).get("role") ?? "overlay";

const fmt = (t?: number) => {
  if (t === undefined || t === null || Number.isNaN(t)) return "--:--";
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export default function App() {
  // In overlay mode the main window only hosts mpv; its webview draws nothing.
  if (role === "host") return null;
  return <Overlay />;
}

function Overlay() {
  const [props, setProps] = useState<Props>({});
  const [info, setInfo] = useState<Info | null>(null);
  const [inputs, setInputs] = useState<string[]>([]);
  const [scrub, setScrub] = useState<number | null>(null);
  const [showInfo, setShowInfo] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  const logInput = useCallback((kind: string, detail: string) => {
    setInputs((xs) => [`${new Date().toLocaleTimeString()} ${kind} ${detail}`, ...xs].slice(0, 6));
    player("ReportInput", role, kind, detail);
  }, []);

  useEffect(() => {
    player("GetProps").then((p) => p && setProps(p as Props));
    player("GetInfo").then((i) => i && setInfo(i as Info));
    const offProp = Events.On("mpv:prop", (e: { data: { name: string; data: unknown } }) =>
      setProps((p) => ({ ...p, [e.data.name]: e.data.data })),
    );
    const offInfo = Events.On("spike:info", (e: { data: Info }) => setInfo(e.data));
    const onKey = (e: KeyboardEvent) => {
      logInput("keydown", e.key);
      if (e.key === " ") player("TogglePause");
      if (e.key === "ArrowRight") player("Seek", 5, false);
      if (e.key === "ArrowLeft") player("Seek", -5, false);
      if (e.key === "i") setShowInfo((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      offProp();
      offInfo();
      window.removeEventListener("keydown", onKey);
    };
  }, [logInput]);

  const tracks = props["track-list"] ?? [];
  const audio = tracks.filter((t) => t.type === "audio");
  const subs = tracks.filter((t) => t.type === "sub");
  const pos = scrub ?? props["time-pos"] ?? 0;
  const dur = props.duration ?? 0;

  return (
    <div
      className="stage"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) logInput("click", `stage @${e.clientX},${e.clientY}`);
      }}
    >
      <div className="badge">React overlay · {role} webview</div>

      {showInfo && (
        <div className="panel info">
          <h2>mpv --wid spike</h2>
          <dl>
            <dt>OS / mode</dt>
            <dd>
              {info?.os ?? "?"} / {info?.mode ?? "?"}
            </dd>
            <dt>--wid</dt>
            <dd>
              {info ? `${info.wid} (${info.widKind})` : "…"}
            </dd>
            <dt>mpv</dt>
            <dd>{info?.mpvVersion || "…"}</dd>
            <dt>embedded</dt>
            <dd className={info?.embed?.embedded ? "ok" : "bad"}>{String(info?.embed?.embedded ?? "…")}</dd>
            <dt>verdict</dt>
            <dd>{String(info?.embed?.verdict ?? "…")}</dd>
            <dt>path</dt>
            <dd className="mono">{props.path ?? "…"}</dd>
            <dt>hwdec</dt>
            <dd>{props["hwdec-current"] ?? "…"}</dd>
          </dl>
          <h3>Input that reached this webview</h3>
          <ul className="mono">{inputs.length ? inputs.map((x, i) => <li key={i}>{x}</li>) : <li>none yet</li>}</ul>
        </div>
      )}

      <div
        ref={boxRef}
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
        <button className="play" aria-label="play-pause" onClick={() => { logInput("click", "play/pause"); player("TogglePause"); }}>
          {props.pause ? "▶" : "❚❚"}
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
      </div>
    </div>
  );
}
