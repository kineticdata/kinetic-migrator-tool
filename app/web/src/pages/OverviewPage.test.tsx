// Overview: lanes per environment, "N differences" arrows from a raw compare
// of snapshots, and fresh data after a snapshot job ends.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { AppRoutes } from '../routes';
import { mockApi, sse } from '../test/mock-api';
import { renderWithApp } from '../test/render';
import { historyEvent, project } from '../test/fixtures';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  let projectCalls = 0;
  const m = mockApi({
    'GET /api/projects/:p': () => { projectCalls++; return project(); },
    'GET /api/projects/:p/history': [
      historyEvent({ id: 'h2', type: 'applied', title: "Applied 'Q4 forms' to Test", env: 'test', status: 'applied', at: '2026-10-08T11:00:00Z' }),
      historyEvent({ id: 'h1', type: 'snapshot', title: 'Snapshot of Test', env: 'test', drifted: ['forms/a', 'forms/b'] }),
    ],
    'GET /api/projects/:p/explore/:env/tree': [
      { id: 'kapps', label: 'Kapps', kind: 'group', count: 12, hasChildren: true },
      { id: 'teams', label: 'Teams', kind: 'group', count: 3, hasChildren: true },
    ],
    'POST /api/projects/:p/compare': { status: 202, json: { jobId: 'cmp1' } },
    'GET /api/jobs/cmp1': { id: 'cmp1', kind: 'compare', status: 'succeeded', createdAt: 'x', result: { compareId: 'k', from: 'dev', fromName: 'Dev', to: 'test', mode: 'raw', sourceCommit: 'c', counts: { new: 2, changed: 3, same: 40 }, preselected: [] } },
    'POST /api/projects/:p/snapshots': { status: 202, json: { jobId: 'snap1' } },
    'GET /api/jobs/snap1/events': { sse: sse([{ type: 'progress', data: { type: 'progress', phase: 'export', done: 2, total: 2 } }]) },
    'GET /api/jobs/snap1': { id: 'snap1', kind: 'snapshot', status: 'succeeded', createdAt: 'x', result: { env: 'dev', commit: 'c2', total: 15, counts: {}, drifted: [] } },
  });
  return { m, projectCalls: () => projectCalls };
}

const lane = async (name: string) => (await screen.findByRole('region', { name: `${name} environment` }));

test('shows a lane per environment with counts, drift and the latest run', async () => {
  setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/overview' });
  const test1 = await lane('Test');
  expect(await within(test1).findByText('15 items')).toBeInTheDocument();
  expect(within(test1).getByText('2 drifted')).toBeInTheDocument();
  expect(within(test1).getByText("Applied 'Q4 forms' to Test")).toBeInTheDocument();
  const prod = await lane('Prod');
  expect(within(prod).getByText('No snapshot yet')).toBeInTheDocument();
  expect(within(prod).getByRole('button', { name: 'Take snapshot' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Recent activity' })).toBeInTheDocument();
});

test('arrows between lanes show the number of differences from snapshots', async () => {
  const { m } = setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/overview' });
  const link = await screen.findByRole('link', { name: '5 differences' });
  expect(link).toHaveAttribute('href', '/p/acme-demo/compare?from=dev&to=test');
  expect(m.callsTo('POST', '/api/projects/acme-demo/compare')[0].body).toEqual({ from: 'dev', to: 'test', mode: 'raw' });
  // Prod has no snapshot: no compare is started for test → prod.
  expect(m.callsTo('POST', '/api/projects/acme-demo/compare')).toHaveLength(1);
});

test('refreshing a snapshot reloads the project when the job ends', async () => {
  const { m, projectCalls } = setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/overview' });
  const dev = await lane('Dev');
  const before = projectCalls();
  await user.click(within(dev).getByRole('button', { name: 'Refresh snapshot' }));
  expect(m.callsTo('POST', '/api/projects/acme-demo/snapshots')[0].body).toEqual({ env: 'dev' });
  await waitFor(() => expect(projectCalls()).toBeGreaterThan(before));
});
