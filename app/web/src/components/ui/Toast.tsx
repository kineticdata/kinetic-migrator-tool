// Toasts (Radix): useToast().show({ title, description, tone }). They go away
// on their own (errors stay longer), at most three show at once, and moving
// to another screen clears all but errors (<ToastRouteReset /> inside the
// router). They sit bottom-right, above whatever a screen reserves there
// (`useToastClearance`, for example the changeset tray's Review plan).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useLocation } from 'react-router';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from './cn';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: 'success' | 'error' | 'info';
}

interface ToastItem extends ToastInput {
  id: number;
}

export const TOAST_MS = 4000;
export const ERROR_TOAST_MS = 8000;
export const MAX_TOASTS = 3;

interface ToastApi {
  show: (t: ToastInput) => void;
  // Dismisses every toast that is not an error.
  clearTransient: () => void;
}

const ToastContext = createContext<ToastApi>({ show: () => {}, clearTransient: () => {} });

export const useToast = () => useContext(ToastContext);

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);
  const show = useCallback((t: ToastInput) => {
    const id = ++seq;
    timers.current.set(id, setTimeout(() => dismiss(id), t.tone === 'error' ? ERROR_TOAST_MS : TOAST_MS));
    setItems((xs) => [...xs, { ...t, id }].slice(-MAX_TOASTS));
  }, [dismiss]);
  const clearTransient = useCallback(() => setItems((xs) => xs.filter((x) => x.tone === 'error')), []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const value = useMemo(() => ({ show, clearTransient }), [show, clearTransient]);
  return (
    <ToastContext.Provider value={value}>
      {/* Timing is ours (Radix pauses its timers whenever the window loses focus). */}
      <ToastPrimitive.Provider swipeDirection="right" duration={Infinity}>
        {children}
        {items.map((t) => {
          const Icon = t.tone === 'error' ? AlertTriangle : t.tone === 'success' ? CheckCircle2 : Info;
          return (
            <ToastPrimitive.Root
              key={t.id}
              type={t.tone === 'error' ? 'foreground' : 'background'}
              onOpenChange={(open) => { if (!open) dismiss(t.id); }}
              className="relative flex items-start gap-3 rounded-xl border border-border bg-surface p-3.5 pr-9 shadow-overlay animate-[km-slide-in_160ms_ease-out]"
            >
              <Icon size={18} aria-hidden className={cn('mt-0.5 shrink-0', t.tone === 'error' ? 'text-danger' : t.tone === 'success' ? 'text-added' : 'text-accent')} />
              <div className="min-w-0">
                <ToastPrimitive.Title className="text-sm font-medium text-fg">{t.title}</ToastPrimitive.Title>
                {t.description && <ToastPrimitive.Description className="mt-0.5 text-sm text-muted">{t.description}</ToastPrimitive.Description>}
              </div>
              <ToastPrimitive.Close aria-label="Dismiss" className="absolute top-2.5 right-2.5 rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg">
                <X size={14} aria-hidden />
              </ToastPrimitive.Close>
            </ToastPrimitive.Root>
          );
        })}
        <ToastPrimitive.Viewport className="fixed right-4 bottom-[var(--km-toast-bottom,1rem)] z-[60] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

// Clears toasts that are not errors when the screen (path) changes.
export function ToastRouteReset() {
  const { pathname } = useLocation();
  const { clearTransient } = useToast();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    clearTransient();
  }, [pathname, clearTransient]);
  return null;
}

// Keeps toasts above an element pinned to the bottom of the window (while it
// is mounted), so they never cover its buttons.
export function useToastClearance(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    const root = document.documentElement;
    if (!el) return undefined;
    const update = () => {
      const rect = el.getBoundingClientRect();
      // Only while it actually sits on the bottom edge (wide layouts).
      if (rect.height === 0 || Math.abs(rect.bottom - window.innerHeight) > 8) root.style.removeProperty('--km-toast-bottom');
      else root.style.setProperty('--km-toast-bottom', `${Math.round(window.innerHeight - rect.top) + 12}px`);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(el);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      root.style.removeProperty('--km-toast-bottom');
    };
  }, [ref]);
}
