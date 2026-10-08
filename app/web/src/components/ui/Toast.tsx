// Toasts (Radix): useToast().show({ title, description, tone }).
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
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

const ToastContext = createContext<{ show: (t: ToastInput) => void }>({ show: () => {} });

export const useToast = () => useContext(ToastContext);

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const show = useCallback((t: ToastInput) => setItems((xs) => [...xs, { ...t, id: ++seq }]), []);
  const value = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider swipeDirection="right" duration={5000}>
        {children}
        {items.map((t) => {
          const Icon = t.tone === 'error' ? AlertTriangle : t.tone === 'success' ? CheckCircle2 : Info;
          return (
            <ToastPrimitive.Root
              key={t.id}
              onOpenChange={(open) => { if (!open) setItems((xs) => xs.filter((x) => x.id !== t.id)); }}
              className="flex items-start gap-3 rounded-xl border border-border bg-surface p-3.5 pr-9 shadow-overlay animate-[km-slide-in_160ms_ease-out] relative"
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
        <ToastPrimitive.Viewport className="fixed right-4 bottom-4 z-[60] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}
