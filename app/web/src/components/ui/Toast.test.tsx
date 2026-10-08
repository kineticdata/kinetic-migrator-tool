// Toasts: they go away on their own (errors later), at most three show, and
// changing screens clears all but errors.
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter, useNavigate } from 'react-router';
import { ERROR_TOAST_MS, TOAST_MS, ToastProvider, ToastRouteReset, useToast, type ToastInput } from './Toast';

let api: { show: (t: ToastInput) => void; go: (to: string) => void };
function Harness() {
  const toast = useToast();
  const navigate = useNavigate();
  api = { show: toast.show, go: (to) => navigate(to) };
  return null;
}

const setup = () => render(
  <ToastProvider>
    <MemoryRouter initialEntries={['/a']}>
      <ToastRouteReset />
      <Harness />
    </MemoryRouter>
  </ToastProvider>,
);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

test('toasts dismiss themselves; errors stay longer', () => {
  setup();
  act(() => {
    api.show({ title: 'Saved', tone: 'success' });
    api.show({ title: 'Broke', tone: 'error' });
  });
  expect(screen.getByText('Saved')).toBeInTheDocument();
  act(() => { vi.advanceTimersByTime(TOAST_MS + 10); });
  expect(screen.queryByText('Saved')).toBeNull();
  expect(screen.getByText('Broke')).toBeInTheDocument();
  act(() => { vi.advanceTimersByTime(ERROR_TOAST_MS - TOAST_MS); });
  expect(screen.queryByText('Broke')).toBeNull();
});

test('at most three show; the oldest goes first', () => {
  setup();
  act(() => { ['One', 'Two', 'Three', 'Four'].forEach((title) => api.show({ title })); });
  expect(screen.queryByText('One')).toBeNull();
  for (const t of ['Two', 'Three', 'Four']) expect(screen.getByText(t)).toBeInTheDocument();
});

test('changing screens clears all but errors', () => {
  setup();
  act(() => {
    api.show({ title: 'Saved', tone: 'success' });
    api.show({ title: 'Broke', tone: 'error' });
  });
  act(() => { api.go('/b'); });
  expect(screen.queryByText('Saved')).toBeNull();
  expect(screen.getByText('Broke')).toBeInTheDocument();
});
