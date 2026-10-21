"use client";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { ChevronRight, Search, X } from "lucide-react";
import { useToasts } from "../lib/api";

type Variant = "primary" | "outline" | "secondary" | "danger" | "text";
export function Button({
  variant = "primary",
  size,
  block,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm";
  block?: boolean;
}) {
  return (
    <button
      type="button"
      className={`btn btn-${variant}${size ? " btn-" + size : ""}${block ? " btn-block" : ""} ${className}`}
      {...props}
    />
  );
}
export function IconButton({
  label,
  active,
  danger,
  size,
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  active?: boolean;
  danger?: boolean;
  size?: "sm";
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`icon-btn${active ? " active" : ""}${danger ? " danger" : ""}${size ? " " + size : ""} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
export function Field({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="label">
        {label}
        {required && <span className="required">*</span>}
      </span>
      {children}
      {error ? (
        <span className="error-text">{error}</span>
      ) : (
        hint && <span className="hint">{hint}</span>
      )}
    </label>
  );
}
export function Check({
  label,
  checked,
  onChange,
  name,
  value,
  defaultChecked,
}: {
  label: ReactNode;
  checked?: boolean;
  onChange?: (v: boolean) => void;
  name?: string;
  value?: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        name={name}
        value={value}
        checked={checked}
        defaultChecked={defaultChecked}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      {label}
    </label>
  );
}
export function SearchInput({
  value,
  onChange,
  placeholder = "Search",
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  id?: string;
}) {
  return (
    <div className="search-input">
      <Search size={17} />
      <input
        id={id}
        className="input"
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className="logo">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 2.5 9 8l-7 5.5V11l4-3-4-3z" fill="currentColor" />
        <rect x="8.5" y="12" width="6" height="2" rx="1" fill="currentColor" />
      </svg>
      {!compact && <span className="word">NexusSSH</span>}
      {!compact && <span className="badge">MCP</span>}
    </span>
  );
}
export function Empty({
  icon,
  title,
  children,
  tall,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  tall?: boolean;
}) {
  return (
    <div className={"empty-state" + (tall ? " tall" : "")}>
      {icon}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}
function useEscape(close: () => void) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", f);
    return () => document.removeEventListener("keydown", f);
  }, [close]);
}
export function Drawer({
  title,
  onClose,
  children,
  footer,
  head,
  wide,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  head?: ReactNode;
  wide?: boolean;
}) {
  useEscape(onClose);
  return createPortal(
    <>
      <div className="mask" onClick={onClose} />
      <aside
        className={"drawer" + (wide ? " wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
      >
        <div className="drawer-head">
          {head}
          <h2>{title}</h2>
          <IconButton label="Close" size="sm" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </>,
    document.body,
  );
}
export function Dialog({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEscape(onClose);
  return createPortal(
    <>
      <div className="mask" onClick={onClose} />
      <div className="dialog-wrap" onClick={onClose}>
        <section
          className="dialog"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="dialog-head">
            <h2>{title}</h2>
            <IconButton label="Close" size="sm" onClick={onClose}>
              <X size={18} />
            </IconButton>
          </div>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-foot">{footer}</div>}
        </section>
      </div>
    </>,
    document.body,
  );
}

// Promise-based confirm/prompt dialogs rendered by <DialogHost />.
type Ask = {
  title: string;
  message?: ReactNode;
  confirm: string;
  danger?: boolean;
  input?: { value: string; label?: string; placeholder?: string };
  resolve: (v: string | boolean | null) => void;
};
const useAsk = create<{ ask: Ask | null; set: (a: Ask | null) => void }>(
  (set) => ({ ask: null, set: (ask) => set({ ask }) }),
);
export const confirmDialog = (
  title: string,
  message: ReactNode,
  confirm = "Confirm",
  danger = false,
) =>
  new Promise<boolean>((resolve) =>
    useAsk.getState().set({
      title,
      message,
      confirm,
      danger,
      resolve: (v) => resolve(Boolean(v)),
    }),
  );
export const promptDialog = (
  title: string,
  label: string,
  value = "",
  confirm = "Save",
) =>
  new Promise<string | null>((resolve) =>
    useAsk.getState().set({
      title,
      confirm,
      input: { value, label },
      resolve: (v) => resolve(typeof v === "string" ? v : null),
    }),
  );
export function DialogHost() {
  const { ask, set } = useAsk();
  const [value, setValue] = useState("");
  useEffect(() => setValue(ask?.input?.value || ""), [ask]);
  if (!ask) return null;
  const done = (v: string | boolean | null) => {
    set(null);
    ask.resolve(v);
  };
  const submit = () => done(ask.input ? value.trim() || null : true);
  return (
    <Dialog
      title={ask.title}
      onClose={() => done(null)}
      footer={
        <>
          <Button variant="secondary" onClick={() => done(null)}>
            Cancel
          </Button>
          <Button variant={ask.danger ? "danger" : "primary"} onClick={submit}>
            {ask.confirm}
          </Button>
        </>
      }
    >
      {ask.message}
      {ask.input && (
        <Field label={ask.input.label}>
          <input
            autoFocus
            className="input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </Field>
      )}
    </Dialog>
  );
}

export type MenuItem =
  | "sep"
  | {
      label: string;
      icon?: ReactNode;
      onClick?: () => void;
      danger?: boolean;
      disabled?: boolean;
      items?: MenuItem[];
    };
const useMenuState = create<{
  menu: { x: number; y: number; items: MenuItem[] } | null;
  set: (m: { x: number; y: number; items: MenuItem[] } | null) => void;
}>((set) => ({ menu: null, set: (menu) => set({ menu }) }));
export const openMenu = (x: number, y: number, items: MenuItem[]) =>
  useMenuState.getState().set({ x, y, items });
export const openMenuAt = (el: Element, items: MenuItem[]) => {
  const r = el.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, items);
};
function MenuList({
  items,
  close,
  style,
  className = "menu",
}: {
  items: MenuItem[];
  close: () => void;
  style?: React.CSSProperties;
  className?: string;
}) {
  const [sub, setSub] = useState(-1);
  return (
    <div className={className} style={style} role="menu">
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="menu-sep" />
        ) : (
          <div
            key={i}
            style={{ position: "relative" }}
            onMouseEnter={() => setSub(it.items ? i : -1)}
          >
            <button
              role="menuitem"
              className={`menu-item${it.danger ? " danger" : ""}${sub === i ? " open" : ""}`}
              disabled={it.disabled}
              onClick={() => {
                if (it.items) return setSub(i);
                close();
                it.onClick?.();
              }}
            >
              {it.icon}
              {it.label}
              {it.items && <ChevronRight className="chev" size={14} />}
            </button>
            {it.items && sub === i && (
              <MenuList
                items={it.items}
                close={close}
                className="menu menu-sub"
              />
            )}
          </div>
        ),
      )}
    </div>
  );
}
export function MenuHost() {
  const { menu, set } = useMenuState();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!menu) return;
    const el = ref.current?.firstElementChild as HTMLElement | null;
    const w = el?.offsetWidth || 180,
      h = el?.offsetHeight || 200;
    setPos({
      x: Math.max(4, Math.min(menu.x, innerWidth - w - 8)),
      y: Math.max(4, menu.y + h > innerHeight - 8 ? menu.y - h : menu.y),
    });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) set(null);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && set(null);
    setTimeout(() => {
      document.addEventListener("mousedown", close);
      document.addEventListener("contextmenu", close);
    });
    document.addEventListener("keydown", key);
    window.addEventListener("blur", () => set(null), { once: true });
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("contextmenu", close);
      document.removeEventListener("keydown", key);
    };
  }, [menu, set]);
  if (!menu) return null;
  return createPortal(
    <div ref={ref}>
      <MenuList
        items={menu.items}
        close={() => set(null)}
        style={{ left: pos.x, top: pos.y }}
      />
    </div>,
    document.body,
  );
}
export function Toasts() {
  const { items, dismiss } = useToasts();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={"toast " + t.kind}>
          <p>{t.text}</p>
          <IconButton label="Dismiss" size="sm" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
