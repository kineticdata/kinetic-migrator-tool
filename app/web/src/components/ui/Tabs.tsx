// Tabs (Radix) for in-page sections.
import type { ReactNode } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from './cn';

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export function TabsList({ children, className, label }: { children: ReactNode; className?: string; label: string }) {
  return (
    <TabsPrimitive.List aria-label={label} className={cn('inline-flex items-center gap-1 rounded-lg bg-surface-2 p-1', className)}>
      {children}
    </TabsPrimitive.List>
  );
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className="rounded-md px-3 py-1 text-[13px] font-medium text-muted transition-colors hover:text-fg data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-card data-[state=active]:ring-1 data-[state=active]:ring-border-strong"
    >
      {children}
    </TabsPrimitive.Trigger>
  );
}
