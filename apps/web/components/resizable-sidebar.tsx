"use client";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

const WIDTH_KEY = "nexus-sidebar-width";
const DEFAULT_WIDTH = 305;
const MIN_WIDTH = 305;
const MAX_WIDTH = 720;
const WORKSPACE_MIN_WIDTH = 360;
const clampWidth = (width: number, maximum: number) =>
  Math.max(MIN_WIDTH, Math.min(maximum, width));

function rememberWidth(width: number) {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {}
}

export function ResizableSidebar({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [maximum, setMaximum] = useState(MAX_WIDTH);
  const [resizing, setResizing] = useState(false);
  const currentWidth = useRef(DEFAULT_WIDTH);
  const drag = useRef<{ x: number; width: number; pointerId: number } | null>(
    null,
  );

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(saved) && saved >= MIN_WIDTH)
        currentWidth.current = clampWidth(saved, MAX_WIDTH);
    } catch {}
    setWidth(currentWidth.current);
    const fit = () => {
      if (matchMedia("(max-width: 760px)").matches) return;
      const max = Math.max(
        MIN_WIDTH,
        Math.min(MAX_WIDTH, window.innerWidth - WORKSPACE_MIN_WIDTH),
      );
      setMaximum(max);
      currentWidth.current = clampWidth(currentWidth.current, max);
      setWidth(currentWidth.current);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("resize", fit);
      document.documentElement.classList.remove("sidebar-resizing");
    };
  }, []);

  const updateWidth = (value: number) => {
    const next = clampWidth(value, maximum);
    currentWidth.current = next;
    setWidth(next);
    return next;
  };
  const finishResize = () => {
    if (!drag.current) return;
    drag.current = null;
    setResizing(false);
    document.documentElement.classList.remove("sidebar-resizing");
    rememberWidth(currentWidth.current);
  };

  return (
    <aside
      id="server-sidebar"
      className={"sidebar" + (resizing ? " resizing" : "")}
      style={{ "--sidebar-width": `${width}px` } as CSSProperties}
    >
      {children}
      <div
        className="sidebar-resize"
        role="separator"
        aria-label="Resize server list"
        aria-orientation="vertical"
        aria-controls="server-sidebar"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maximum}
        aria-valuenow={width}
        aria-valuetext={`${width} pixels`}
        tabIndex={0}
        title="Drag to resize; double-click to reset"
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            x: event.clientX,
            width: currentWidth.current,
            pointerId: event.pointerId,
          };
          setResizing(true);
          document.documentElement.classList.add("sidebar-resizing");
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start?.pointerId === event.pointerId)
            updateWidth(start.width + event.clientX - start.x);
        }}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
        onDoubleClick={() => rememberWidth(updateWidth(DEFAULT_WIDTH))}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 48 : 16;
          let next: number;
          switch (event.key) {
            case "ArrowLeft":
              next = width - step;
              break;
            case "ArrowRight":
              next = width + step;
              break;
            case "Home":
              next = MIN_WIDTH;
              break;
            case "End":
              next = maximum;
              break;
            case "Enter":
              next = DEFAULT_WIDTH;
              break;
            default:
              return;
          }
          event.preventDefault();
          rememberWidth(updateWidth(next));
        }}
      />
    </aside>
  );
}
