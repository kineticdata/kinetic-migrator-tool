// App-wide UI providers (toasts and tooltips). Query client and router are
// supplied by App (and by the test helper).
import type { ReactNode } from 'react';
import { ToastProvider } from './components/ui/Toast';
import { TooltipProvider } from './components/ui/Tooltip';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={300}>
      <ToastProvider>{children}</ToastProvider>
    </TooltipProvider>
  );
}
