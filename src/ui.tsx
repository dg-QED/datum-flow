import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

// ------------------------------------------------------------- icons (stroke, 16px)
const P = (d: string) => <path d={d} />;
const ICONS: Record<string, ReactNode> = {
  layers: <>{P("M12 3l9 5-9 5-9-5z")}{P("M3 13l9 5 9-5")}</>,
  table: <>{P("M3 5h18v14H3z")}{P("M3 10h18M3 15h18M9 5v14")}</>,
  tools: <>{P("M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8V21h3.2l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.6-.6-2.4z")}</>,
  style: <>{P("M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.6 0-1.3-1-1.6-1-2.9 0-1 .8-1.5 1.8-1.5H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z")}<circle cx="7.5" cy="11" r="1.2" /><circle cx="10.5" cy="7" r="1.2" /><circle cx="15" cy="7.5" r="1.2" /></>,
  legend: <>{P("M4 5h4v4H4zM4 15h4v4H4z")}{P("M11 7h9M11 17h9")}</>,
  info: <><circle cx="12" cy="12" r="9" />{P("M12 11v6M12 7.5v.5")}</>,
  identify: <><circle cx="12" cy="12" r="9" />{P("M12 11v6M12 7.5v.5")}</>,
  select: <>{P("M5 3l14 8-6 2-2 6z")}</>,
  box: <>{P("M4 4h3M10 4h4M17 4h3v3M20 10v4M20 17v3h-3M14 20h-4M7 20H4v-3M4 14v-4M4 7V4")}</>,
  expr: <>{P("M8 4c-2 0-2 1.5-2 3s0 3-2 3c2 0 2 1.5 2 3s0 3 2 3M16 4c2 0 2 1.5 2 3s0 3 2 3c-2 0-2 1.5-2 3s0 3-2 3")}</>,
  ruler: <>{P("M3 17L17 3l4 4L7 21z")}{P("M7 13l2 2M10 10l2 2M13 7l2 2")}</>,
  area: <>{P("M4 6l7-3 9 5-3 11-11-2z")}</>,
  bearing: <><circle cx="12" cy="12" r="9" />{P("M12 12l4-7M12 3v2M21 12h-2M12 21v-2M3 12h2")}</>,
  pencil: <>{P("M4 20h4L19 9l-4-4L4 16z")}{P("M13.5 6.5l4 4")}</>,
  point: <><circle cx="12" cy="12" r="3.5" /></>,
  line: <>{P("M4 18L10 9l5 5 5-9")}</>,
  polygon: <>{P("M5 7l7-4 7 5-2 10H7z")}</>,
  rect: <>{P("M4 6h16v12H4z")}</>,
  circle: <><circle cx="12" cy="12" r="8" /></>,
  move: <>{P("M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3")}</>,
  undo: <>{P("M9 14L4 9l5-5")}{P("M4 9h10a6 6 0 0 1 0 12h-3")}</>,
  redo: <>{P("M15 14l5-5-5-5")}{P("M20 9H10a6 6 0 0 0 0 12h3")}</>,
  trash: <>{P("M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3")}</>,
  eye: <>{P("M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z")}<circle cx="12" cy="12" r="3" /></>,
  eyeoff: <>{P("M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.6M6.6 6.6C3.9 8.4 2 12 2 12s4 7 10 7a9.8 9.8 0 0 0 4.4-1")}</>,
  grip: <><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></>,
  zoomto: <>{P("M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5")}<circle cx="12" cy="12" r="2.5" /></>,
  fit: <>{P("M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5")}</>,
  plus: <>{P("M12 5v14M5 12h14")}</>,
  minus: <>{P("M5 12h14")}</>,
  x: <>{P("M6 6l12 12M18 6L6 18")}</>,
  chevron: <>{P("M9 6l6 6-6 6")}</>,
  down: <>{P("M6 9l6 6 6-6")}</>,
  folder: <>{P("M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z")}</>,
  upload: <>{P("M12 16V4M7 9l5-5 5 5M4 20h16")}</>,
  download: <>{P("M12 3v12M7 10l5 5 5-5M4 21h16")}</>,
  save: <>{P("M5 3h11l3 3v15H5z")}{P("M8 3v5h8M8 21v-7h8v7")}</>,
  image: <>{P("M3 5h18v14H3z")}<circle cx="8.5" cy="10" r="1.5" />{P("M21 16l-5-5-8 8")}</>,
  map: <>{P("M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z")}{P("M9 4v14M15 6v14")}</>,
  globe: <><circle cx="12" cy="12" r="9" />{P("M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18")}</>,
  north: <>{P("M12 3l5 16-5-4-5 4z")}</>,
  cube: <>{P("M12 2l9 5v10l-9 5-9-5V7z")}{P("M3 7l9 5 9-5M12 12v10")}</>,
  target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" />{P("M12 2v3M12 19v3M2 12h3M19 12h3")}</>,
  more: <><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></>,
  rename: <>{P("M4 20h4L19 9l-4-4L4 16z")}</>,
  group: <>{P("M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z")}{P("M12 11v5M9.5 13.5h5")}</>,
  sort: <>{P("M8 4v16M4 16l4 4 4-4M16 20V4M12 8l4-4 4 4")}</>,
  sortup: <>{P("M12 19V5M6 11l6-6 6 6")}</>,
  sortdown: <>{P("M12 5v14M6 13l6 6 6-6")}</>,
  calc: <>{P("M5 3h14v18H5z")}{P("M8 7h8M8 12h2M14 12h2M8 16h2M14 16h2")}</>,
  filter: <>{P("M3 5h18l-7 8v6l-4 2v-8z")}</>,
  check: <>{P("M5 12l5 5L20 7")}</>,
  play: <>{P("M7 4l13 8-13 8z")}</>,
  print: <>{P("M6 9V3h12v6M6 18H4v-7h16v7h-2")}{P("M6 14h12v7H6z")}</>,
  raster: <>{P("M3 3h18v18H3z")}{P("M3 9h18M3 15h18M9 3v18M15 3v18")}</>,
  copy: <>{P("M9 9h11v11H9z")}{P("M5 15H4V4h11v1")}</>,
  plan: <>{P("M3 3h18v18H3z")}{P("M3 12h8v9M11 3v5M15 12h6")}</>,
  sheet: <>{P("M4 4h16v16H4z")}{P("M4 14h16")}</>,
  panelL: <>{P("M3 4h18v16H3z")}{P("M9 4v16")}</>,
  panelR: <>{P("M3 4h18v16H3z")}{P("M15 4v16")}</>,
  panelB: <>{P("M3 4h18v16H3z")}{P("M3 14h18")}</>,
  wall: <>{P("M3 7h18v4H3zM3 14h10v4H3z")}</>,
  obstacle: <>{P("M5 5h14v14H5z")}{P("M5 5l14 14M19 5L5 19")}</>,
  door: <>{P("M4 20h4V6M8 20a12 12 0 0 1 12-12")}{P("M20 8v12h-4")}</>,
  exit: <>{P("M10 4H5v16h5")}{P("M14 8l4 4-4 4M18 12H9")}</>,
  stair: <>{P("M3 20h5v-5h5v-5h5V5h3")}</>,
  seating: <>{P("M4 8h16M4 12h16M4 16h16")}{P("M4 6v12M20 6v12")}</>,
  spawn: <><circle cx="8" cy="9" r="2" /><circle cx="15" cy="8" r="2" /><circle cx="12" cy="15" r="2" />{P("M3 3h18v18H3z")}</>,
  attractor: <>{P("M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z")}<circle cx="12" cy="10" r="2.5" /></>,
  barrier: <>{P("M4 12h16")}{P("M9 7l4 5-4 5M14 7l4 5-4 5")}</>,
  calibrate: <>{P("M4 18L18 4")}<circle cx="4" cy="18" r="2" /><circle cx="18" cy="4" r="2" />{P("M8 20h12")}</>,
  pause: <>{P("M8 5v14M16 5v14")}</>,
  stepf: <>{P("M6 5l9 7-9 7z")}{P("M18 5v14")}</>,
  rewind: <>{P("M11 19l-9-7 9-7zM22 19l-9-7 9-7z")}</>,
  video: <>{P("M3 6h13v12H3z")}{P("M16 10l5-3v10l-5-3")}</>,
  chart: <>{P("M4 20V4M4 20h16")}{P("M7 16l4-5 3 3 5-7")}</>,
  users: <><circle cx="9" cy="8" r="3" />{P("M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6")}<circle cx="17" cy="9" r="2.4" />{P("M16 14.2c2.8.3 5 2.6 5 5.8")}</>,
  grid: <>{P("M4 4h16v16H4zM4 10h16M4 15h16M10 4v16M15 4v16")}</>,
  magnet: <>{P("M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z")}</>,
  dice: <>{P("M4 4h16v16H4z")}<circle cx="8.5" cy="8.5" r="1.2" /><circle cx="15.5" cy="15.5" r="1.2" /><circle cx="12" cy="12" r="1.2" /></>,
  stack: <>{P("M12 3l9 4-9 4-9-4z")}{P("M3 12l9 4 9-4M3 17l9 4 9-4")}</>,
  pdf: <>{P("M6 3h9l4 4v14H6z")}{P("M15 3v4h4M9 13h6M9 17h4")}</>,
  heat: <>{P("M12 3c3 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-4 2-7 2 1 3 3 3 5 1-2 1-5 1-9z")}</>,
  follow: <><circle cx="12" cy="12" r="3" />{P("M12 2v4M12 18v4M2 12h4M18 12h4")}</>,
  flow: <>{P("M3 17c4 0 5-10 9-10s5 10 9 10")}</>,
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name] ?? null}
    </svg>
  );
}

export function GeomIcon({ geom, color }: { geom: string; color?: string }) {
  const c = color ?? "currentColor";
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
      {geom === "point" && <circle cx="8" cy="8" r="3.6" fill={c} />}
      {geom === "line" && <path d="M2 12 L6 6 L10 10 L14 4" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />}
      {geom === "polygon" && <path d="M3 5 L9 2.5 L13.5 6 L12 13 L4 12.5 Z" fill={c} fillOpacity=".55" stroke={c} strokeWidth="1.2" strokeLinejoin="round" />}
      {geom === "mixed" && <><circle cx="4.5" cy="11.5" r="2.2" fill={c} /><path d="M7 4h7v7H7z" fill={c} fillOpacity=".5" stroke={c} strokeWidth="1" /></>}
      {geom === "service" && <><circle cx="8" cy="8" r="5.6" fill="none" stroke={c} strokeWidth="1.2" /><path d="M2.6 8h10.8M8 2.4c2 2 2 9.2 0 11.2M8 2.4c-2 2-2 9.2 0 11.2" fill="none" stroke={c} strokeWidth="1" /></>}
      {geom === "raster" && <path d="M2.5 2.5h11v11h-11zM2.5 8h11M8 2.5v11" fill="none" stroke={c} strokeWidth="1.2" />}
      {geom === "empty" && <path d="M3 3h10v10H3z" fill="none" stroke={c} strokeDasharray="2 2" />}
    </svg>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect x="1" y="1" width="30" height="30" rx="7" fill="#171c21" stroke="#323a43" />
      <path d="M6 21c4 0 5-8 10-8s6 8 10 8" fill="none" stroke="#f2a93b" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="9" cy="11" r="1.8" fill="#f2a93b" /><circle cx="16" cy="8" r="1.8" fill="#f2a93b" /><circle cx="23" cy="11" r="1.8" fill="#f2a93b" />
      <path d="M6 25.5h20" stroke="#6f7983" strokeWidth="1.4" strokeLinecap="round" strokeDasharray="1.5 3" />
    </svg>
  );
}

// ------------------------------------------------------------- toasts
type Toast = { id: number; msg: string; kind: "ok" | "err" | "info" };
const ToastCtx = createContext<(msg: string, kind?: Toast["kind"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [t, setT] = useState<Toast | null>(null);
  const push = useCallback((msg: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setT({ id, msg, kind });
    setTimeout(() => setT((cur) => (cur && cur.id === id ? null : cur)), kind === "err" ? 7000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {t && <div className={`toast ${t.kind}`} role="status" onClick={() => setT(null)}>{t.msg}</div>}
    </ToastCtx.Provider>
  );
}

// ------------------------------------------------------------- modal
export function Modal({ title, children, onClose, footer, width }: { title: ReactNode; children: ReactNode; onClose: () => void; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <h3>{title}</h3>
        {children}
        {footer && <div className="foot">{footer}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- dropdown menu
export function Menu({ button, children, align = "right" }: { button: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<React.CSSProperties | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) setOpen(false); };
    const close = () => setOpen(false);
    window.addEventListener("pointerdown", h);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("pointerdown", h); window.removeEventListener("resize", close); };
  }, [open]);
  // fixed positioning: escapes scroll / overflow containers; opens upward when there is no room below
  useLayoutEffect(() => {
    if (!open || !ref.current) { setPos(null); return; }
    const r = ref.current.getBoundingClientRect();
    const h = pop.current?.offsetHeight ?? 0, w = pop.current?.offsetWidth ?? 230;
    const up = r.bottom + h + 12 > window.innerHeight && r.top - h - 12 > 0;
    const p: React.CSSProperties = { position: "fixed", zIndex: 200 };
    if (up) p.bottom = window.innerHeight - r.top + 4; else p.top = r.bottom + 4;
    if (align === "left" || r.right - w < 8) p.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)); else p.right = Math.max(8, window.innerWidth - r.right);
    setPos(p);
  }, [open, align]);
  return (
    <div className="menu" ref={ref}>
      {button(open, () => setOpen((o) => !o))}
      {open && <div ref={pop} className="menu-pop" style={pos ?? { position: "fixed", visibility: "hidden", top: 0, left: 0 }}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

// ------------------------------------------------------------- collapsible section
export function Section({ title, n, children, defaultOpen = true, right }: { title: ReactNode; n?: ReactNode; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="sect">
      <div className="sect-h" onClick={() => setOpen((o) => !o)}>
        <span className={`tw ${open ? "open" : ""}`}><Icon name="chevron" size={12} /></span>
        {title}
        {n !== undefined && <span className="n">{n}</span>}
        {right && <span onClick={(e) => e.stopPropagation()} style={{ marginLeft: n !== undefined ? 8 : "auto" }}>{right}</span>}
      </div>
      {open && <div className="sect-b">{children}</div>}
    </div>
  );
}

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <div className="field"><label>{label}</label><div className="ctl">{children}</div></div>;
}

export function useMedia(q: string) {
  const [m, setM] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}
