// Theme menu: System, Light or Dark.
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type ThemeChoice } from '../lib/theme';

const choices: Array<{ value: ThemeChoice; label: string; Icon: typeof Sun }> = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
];

export function ThemeToggle() {
  const [choice, setChoice] = useTheme();
  const Current = choices.find((c) => c.value === choice)?.Icon ?? Monitor;
  return (
    <Menu.Root>
      <Menu.Trigger aria-label="Theme" title="Theme" className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
        <Current size={16} aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" sideOffset={6} className="z-50 min-w-36 rounded-xl border border-border bg-surface p-1 shadow-overlay">
          <Menu.RadioGroup value={choice} onValueChange={(v) => setChoice(v as ThemeChoice)}>
            {choices.map(({ value, label, Icon }) => (
              <Menu.RadioItem key={value} value={value} className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-fg outline-none data-[highlighted]:bg-surface-2">
                <Icon size={14} aria-hidden className="text-muted" />
                <span className="flex-1">{label}</span>
                <Menu.ItemIndicator><Check size={14} aria-hidden className="text-accent" /></Menu.ItemIndicator>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
