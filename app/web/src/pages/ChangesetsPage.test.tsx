// Changesets: saved selections, where each has been applied, and planning one
// against any environment.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { Changeset } from '../../../shared/sync-api';
import { AppRoutes } from '../routes';
import { mockApi, sse } from '../test/mock-api';
import { currentLocation, renderWithApp } from '../test/render';
import { historyEvent, project } from '../test/fixtures';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const CS: Changeset = {
  id: 'q4-forms-a1b2c3',
  name: 'Q4 forms',
  description: 'Leave and travel forms for the Q4 release',
  from: 'dev',
  sourceCommit: 'c-pinned',
  keys: ['kapps/hr/forms/leave/form', 'connections/tickets/operations/create'],
  createdAt: '2026-10-08T11:00:00Z',
  appliedTo: [{ env: 'test', runId: 'r1', at: '2026-10-08T11:30:00Z' }],
};

function setup() {
  return mockApi({
    'GET /api/projects/:p': project(),
    'GET /api/projects/:p/history': [historyEvent({ commit: 'c-pinned', at: '2026-10-05T09:00:00Z' })],
    'GET /api/projects/:p/changesets': [CS],
    'GET /api/projects/:p/changesets/:id': (_c: unknown, { id }: Record<string, string>) => (id === CS.id ? CS : { status: 404, json: { error: { code: 'not_found', message: 'No such changeset.' } } }),
    'POST /api/projects/:p/plans': { status: 202, json: { jobId: 'plan9' } },
    'GET /api/jobs/plan9/events': { sse: sse([]) },
    'GET /api/jobs/plan9': { id: 'plan9', kind: 'plan', status: 'succeeded', createdAt: 'x', result: { planId: 'pl9' } },
    'DELETE /api/projects/:p/changesets/:id': { deleted: CS.id },
    'POST /api/projects/:p/compare': { status: 202, json: { jobId: 'cmp9' } },
    'GET /api/jobs/cmp9/events': { sse: sse([]) },
    'GET /api/jobs/cmp9': {
      id: 'cmp9', kind: 'compare', status: 'succeeded', createdAt: 'x',
      result: { compareId: 'cz', from: 'dev', fromName: 'Dev', to: 'test', mode: 'preview', sourceCommit: 'c-pinned', counts: {}, preselected: [] },
    },
    'GET /api/projects/:p/compare/cz/item': (call: { search: string }) => {
      const key = new URLSearchParams(call.search).get('key');
      if (key === CS.keys[0]) {
        return { key, type: 'form', label: 'Leave request', status: 'changed', diff: [{ path: 'description', from: 'old', to: 'new' }], current: {}, incoming: {} };
      }
      return { key, type: 'operation', label: 'Create ticket', status: 'same', diff: [], current: {}, incoming: {} };
    },
  });
}

test('lists changesets with their source, pinned snapshot, size and where they were applied', async () => {
  setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/changesets' });
  const table = await screen.findByRole('table', { name: 'Changesets' });
  const r = within(table).getByRole('row', { name: /Q4 forms/ });
  expect(r).toHaveTextContent('Leave and travel forms');
  expect(r).toHaveTextContent('Dev');
  expect(r).toHaveTextContent('Oct 5, 2026');
  expect(r).toHaveTextContent('2');
  expect(r).toHaveTextContent('Test');
  await user.click(within(r).getByRole('link', { name: 'Q4 forms' }));
  expect(currentLocation()).toBe(`/p/acme-demo/changesets/${CS.id}`);
});

test('a changeset’s items, and Plan against… starts a plan and opens it', async () => {
  const m = setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: `/p/acme-demo/changesets/${CS.id}` });
  expect(await screen.findByRole('heading', { name: 'Q4 forms' })).toBeInTheDocument();
  const items = screen.getByRole('region', { name: 'Items' });
  expect(within(items).getByText('leave')).toBeInTheDocument();
  expect(within(items).getByText('kapps/hr/forms/leave/form')).toBeInTheDocument();
  expect(within(items).getByText('create')).toBeInTheDocument();

  const target = screen.getByLabelText('Plan against');
  // The source itself is not a target.
  expect(within(target).queryByRole('option', { name: 'Dev' })).toBeNull();
  await user.selectOptions(target, 'prod');
  await user.click(screen.getByRole('button', { name: 'Review plan' }));
  await waitFor(() => expect(currentLocation()).toBe('/p/acme-demo/plan/pl9'));
  expect(m.callsTo('POST', '/api/projects/acme-demo/plans')[0].body).toEqual({ to: 'prod', changesetId: CS.id });
});

test('an empty list points to Compare', async () => {
  mockApi({ 'GET /api/projects/:p': project(), 'GET /api/projects/:p/history': [], 'GET /api/projects/:p/changesets': [] });
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/changesets' });
  expect(await screen.findByText('No saved changesets yet')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Compare environments' })).toHaveAttribute('href', '/p/acme-demo/compare');
});

test('Compare with… shows how the pinned items differ from an environment', async () => {
  const m = setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: `/p/acme-demo/changesets/${CS.id}` });
  await screen.findByRole('heading', { name: 'Q4 forms' });
  await user.selectOptions(screen.getByLabelText('Compare with'), 'test');
  await user.click(screen.getByRole('button', { name: 'Compare' }));
  const list = await screen.findByRole('list', { name: 'Differences from Test' });
  expect(await within(list).findByText('Leave request')).toBeInTheDocument();
  expect(within(list).getByText('Create ticket')).toBeInTheDocument();
  expect(m.callsTo('POST', '/api/projects/acme-demo/compare')[0].body).toEqual({ from: 'dev', to: 'test', mode: 'preview', useSnapshots: true, sourceCommit: 'c-pinned' });
  await user.click(within(list).getByText('Leave request'));
  expect(await screen.findByRole('table', { name: 'Changes' })).toHaveTextContent('Description');
});

test('removals show the environment they were chosen for; ones saved without it are confirmed for one first', async () => {
  const unbound: Changeset = { ...CS, id: 'tidy-000001', name: 'Tidy', keys: [], remove: ['teams/contractors'] };
  const m = mockApi({
    'GET /api/projects/:p': project(),
    'GET /api/projects/:p/history': [historyEvent({ commit: 'c-pinned', at: '2026-10-05T09:00:00Z' })],
    'GET /api/projects/:p/changesets/:id': unbound,
    'PUT /api/projects/:p/changesets/:id': { ...unbound, removeFrom: 'test' },
  });
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: `/p/acme-demo/changesets/${unbound.id}` });
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('These removals are for');
  expect(screen.getByRole('list', { name: 'Removals' })).toHaveTextContent('contractors');
  await user.click(within(alert).getByRole('button', { name: /Confirm removals for/ }));
  await waitFor(() => expect(m.callsTo('PUT', `/api/projects/acme-demo/changesets/${unbound.id}`)).toHaveLength(1));
  expect(m.callsTo('PUT', `/api/projects/acme-demo/changesets/${unbound.id}`)[0].body).toEqual({ removeFrom: 'test' });
});
