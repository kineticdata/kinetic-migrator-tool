// History: a timeline grouped by day with environment and type filters, and a
// detail panel with Open in Compare, View plan and Restore….
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { HistoryDetail, HistoryEvent, RunRecord } from '../../../shared/sync-api';
import { AppRoutes } from '../routes';
import { mockApi } from '../test/mock-api';
import { currentLocation, renderWithApp } from '../test/render';
import { historyEvent, project } from '../test/fixtures';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const RUN: RunRecord = {
  id: 'r1', kind: 'apply', name: 'Q4 forms', planId: 'pl1', changesetId: 'q4', from: 'dev', to: 'test',
  source: { commit: 'c-src', path: 'snapshots/dev' }, backupCommit: 'c-backup',
  startedAt: '2026-10-07T10:00:00Z', finishedAt: '2026-10-07T10:01:05Z', status: 'partial',
  selection: ['teams/Ops', 'kapps/hr/forms/leave/form'], acknowledgements: ['drift:teams/Ops'], resolutions: {},
  values: { 'kapps/hr/forms/leave/form': { 'attributes/Web Server Url': 'https://test.your-space.kinops.io' } },
  secretsUsed: [], items: [{ key: 'teams/Ops', status: 'done' }, { key: 'kapps/hr/forms/leave/form', status: 'failed', message: 'Form rejected' }],
  done: 1, error: 'Form rejected',
};

const EVENTS: HistoryEvent[] = [
  historyEvent({ id: 'c-snap-t', commit: 'c-snap-t', type: 'snapshot', title: 'Snapshot of Test', env: 'test', at: '2026-10-08T11:00:00Z' }),
  historyEvent({ id: 'c-snap-t:drift', commit: 'c-snap-t', type: 'drift', title: 'Drift detected in Test: 1 item(s) changed since the last promotion', env: 'test', at: '2026-10-08T11:00:00Z', drifted: ['teams/Ops'] }),
  historyEvent({ id: 'c-applied', commit: 'c-applied', type: 'applied', title: "Partly applied 'Q4 forms' to Test", env: 'test', at: '2026-10-07T10:01:05Z', runId: 'r1', status: 'partial', author: 'Pat Example' }),
  historyEvent({ id: 'c-backup', commit: 'c-backup', type: 'backup', title: 'Backup of Test', env: 'test', at: '2026-10-07T10:00:10Z' }),
  historyEvent({ id: 'c-cs', commit: 'c-cs', type: 'changeset', title: "Saved changeset 'Q4 forms'", env: 'dev', at: '2026-10-06T09:00:00Z' }),
  historyEvent({ id: 'c-restore', commit: 'c-restore', type: 'restore', title: 'Restored Test from a backup', env: 'test', at: '2026-10-05T09:00:00Z', status: 'applied' }),
  historyEvent({ id: 'c-snap-d', commit: 'c-snap-d', type: 'snapshot', title: 'Snapshot of Dev', env: 'dev', at: '2026-10-05T08:00:00Z' }),
  historyEvent({ id: 'c-init', commit: 'c-init', type: 'project', title: 'Created project', env: null, at: '2026-10-04T08:00:00Z' }),
];

function setup() {
  return mockApi({
    'GET /api/projects/:p': project(),
    'GET /api/projects/:p/history': EVENTS,
    'GET /api/projects/:p/history/:commit': (_c: unknown, { commit }: Record<string, string>): HistoryDetail | unknown => {
      const event = EVENTS.find((e) => e.commit === commit && e.type !== 'drift');
      if (!event) return { status: 404, json: { error: { code: 'not_found', message: 'No such commit in this project.' } } };
      return { event, run: event.runId ? RUN : null };
    },
  });
}

test('renders every event type on a timeline grouped by day', async () => {
  setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/history' });
  const timeline = await screen.findByRole('list', { name: 'Timeline' });
  for (const label of ['Snapshot', 'Drift detected', 'Partly applied', 'Backup', 'Changeset saved', 'Restored', 'Project']) {
    expect(within(timeline).getAllByText(label).length).toBeGreaterThan(0);
  }
  expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
    'Oct 8, 2026', 'Oct 7, 2026', 'Oct 6, 2026', 'Oct 5, 2026', 'Oct 4, 2026',
  ].map((d) => expect.stringContaining(d.split(',')[0])));
  // No commit ids in the primary UI.
  expect(timeline).not.toHaveTextContent('c-applied');
});

test('filters by environment and type, kept in the URL', async () => {
  setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/history' });
  await screen.findByRole('list', { name: 'Timeline' });
  await user.selectOptions(screen.getByLabelText('Environment'), 'dev');
  const timeline = screen.getByRole('list', { name: 'Timeline' });
  expect(within(timeline).getAllByRole('button').map((b) => b.textContent)).toEqual([
    expect.stringContaining("Saved changeset 'Q4 forms'"), expect.stringContaining('Snapshot of Dev'),
  ]);
  expect(currentLocation()).toContain('env=dev');
  await user.selectOptions(screen.getByLabelText('Environment'), '');
  await user.selectOptions(screen.getByLabelText('Type'), 'applied');
  expect(within(screen.getByRole('list', { name: 'Timeline' })).getAllByRole('button')).toHaveLength(1);
  expect(currentLocation()).toContain('type=applied');
});

test('?commit= opens that entry’s detail: who, when, duration, counts, acknowledgements and values', async () => {
  setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/history?commit=c-applied' });
  const panel = await screen.findByRole('region', { name: 'Details' });
  expect(within(panel).getByRole('heading', { name: "Partly applied 'Q4 forms' to Test" })).toBeInTheDocument();
  await within(panel).findByText('1m 5s');
  expect(panel).toHaveTextContent('Pat Example');
  expect(panel).toHaveTextContent('2 selected');
  expect(panel).toHaveTextContent('1 done');
  expect(panel).toHaveTextContent('1 failed');
  expect(panel).toHaveTextContent('drift:teams/Ops');
  expect(panel).toHaveTextContent('Web Server Url');
  expect(panel).toHaveTextContent('https://test.your-space.kinops.io');
  expect(panel).toHaveTextContent('Form rejected');
  // The selected entry is marked on the timeline.
  const current = within(screen.getByRole('list', { name: 'Timeline' })).getByRole('button', { pressed: true });
  expect(current).toHaveTextContent("Partly applied 'Q4 forms' to Test");
  // Commit id under Advanced only.
  await user.click(within(panel).getByText('Advanced'));
  expect(panel).toHaveTextContent('c-applied');

  expect(within(panel).getByRole('link', { name: /View plan/ })).toHaveAttribute('href', '/p/acme-demo/plan/pl1');
  expect(within(panel).getByRole('link', { name: /Open in Compare/ })).toHaveAttribute('href', '/p/acme-demo/compare?from=dev&to=test');
});

test('Restore… on an apply opens Compare with its backup as From and the target as To', async () => {
  setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/history?commit=c-applied' });
  const panel = await screen.findByRole('region', { name: 'Details' });
  await user.click(await within(panel).findByRole('button', { name: /Restore/ }));
  await waitFor(() => expect(currentLocation()).toBe('/p/acme-demo/compare?restore=c-backup&to=test'));
});

test('selecting a backup on the timeline opens it; Restore… uses that backup', async () => {
  setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/history' });
  const timeline = await screen.findByRole('list', { name: 'Timeline' });
  await user.click(within(timeline).getByRole('button', { name: /Backup of Test/ }));
  expect(currentLocation()).toContain('commit=c-backup');
  const panel = await screen.findByRole('region', { name: 'Details' });
  await within(panel).findByRole('heading', { name: 'Backup of Test' });
  expect(within(panel).queryByRole('link', { name: /View plan/ })).toBeNull();
  await user.click(within(panel).getByRole('button', { name: /Restore/ }));
  await waitFor(() => expect(currentLocation()).toBe('/p/acme-demo/compare?restore=c-backup&to=test'));
});

test('an unknown ?commit= says so', async () => {
  setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/history?commit=0000000' });
  const panel = await screen.findByRole('region', { name: 'Details' });
  expect(await within(panel).findByText(/No such commit/)).toBeInTheDocument();
});

test('an empty history shows a calm empty state', async () => {
  mockApi({ 'GET /api/projects/:p': project(), 'GET /api/projects/:p/history': [] });
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/history' });
  expect(await screen.findByText(/Nothing has happened yet/)).toBeInTheDocument();
});
