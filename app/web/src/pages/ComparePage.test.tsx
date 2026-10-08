// Compare: a comparison of two environments as a diff tree with tri-state
// checkboxes, a detail pane (changes, side-by-side JSON, three-way drift) and
// the changeset tray with explained suggestions.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CompareItem, CompareResult, CompareTreeNode, SuggestionOut } from '../../../shared/sync-api';
import { AppRoutes } from '../routes';
import { mockApi, sse, type MockCall } from '../test/mock-api';
import { currentLocation, renderWithApp } from '../test/render';
import { historyEvent, project } from '../test/fixtures';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 400, width: 400, height: 800, toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400);
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const n = (id: string, label: string, over: Partial<CompareTreeNode> = {}): CompareTreeNode => ({
  id, label, kind: 'form', key: id, count: 0, hasChildren: false, counts: {}, ...over,
});
const group = (id: string, label: string, counts: CompareTreeNode['counts'], over: Partial<CompareTreeNode> = {}) => n(id, label, {
  kind: 'group', key: undefined, hasChildren: true, count: 1, counts, ...over,
});

const LEAVE = 'kapps/hr/forms/leave/form';
const TRAVEL = 'kapps/hr/forms/travel/form';
const APPROVAL = 'kapps/hr/forms/approval/form';
const CREATE_OP = 'connections/tickets/operations/create';

function tree(withLeave: boolean): Record<string, CompareTreeNode[]> {
  const formCounts = { ...(withLeave ? { new: 1 } : {}), changed: 1, drifted: 1, same: 1 };
  return {
    '': [
      group('group:kapps', 'Kapps', formCounts),
      group('group:connections', 'Connections', { new: 1 }),
      group('group:handlers', 'Handlers', { drifted: 1 }),
      group('group:teams', 'Teams', { 'only-target': 1 }),
      group('group:models', 'Models', { same: 1 }),
    ],
    'group:kapps': [n('kapps/hr/kapp', 'HR', { kind: 'kapp', status: 'same', hasChildren: true, counts: formCounts })],
    'kapps/hr/kapp': [group('group:kapps/hr/forms', 'Forms', formCounts)],
    'group:kapps/hr/forms': [
      n(APPROVAL, 'Approval', { status: 'drifted' }),
      ...(withLeave ? [n(LEAVE, 'Leave request', { status: 'new' })] : []),
      n('kapps/hr/forms/same/form', 'Unchanged form', { status: 'same' }),
      n(TRAVEL, 'Travel request', { status: 'changed' }),
    ],
    'group:connections': [n('connections/tickets/connection', 'Tickets', { kind: 'connection', status: 'same', hasChildren: true, counts: { new: 1 } })],
    'connections/tickets/connection': [n(CREATE_OP, 'Create ticket', { kind: 'operation', status: 'new' })],
    'group:handlers': [n('handlers/mail/handler', 'Mail', { kind: 'handler', status: 'drifted' })],
    'group:teams': [n('teams/ops', 'Operations', { kind: 'team', status: 'only-target' })],
    'group:models': [n('models/people', 'People', { kind: 'model', status: 'same' })],
  };
}

const result = (compareId: string, withLeave = true): CompareResult => ({
  compareId, from: 'dev', fromName: 'Dev', to: 'test', mode: 'preview', sourceCommit: 'c-dev',
  counts: { ...(withLeave ? { new: 2 } : { new: 1 }), changed: 1, drifted: 1, 'only-target': 1, same: 2 }, preselected: [],
});

const ITEMS: Record<string, CompareItem> = {
  [TRAVEL]: {
    key: TRAVEL, type: 'form', label: 'Travel request', status: 'changed',
    diff: [{ path: 'pages[Details].elements[Priority].required', from: false, to: true }],
    current: { name: 'Travel request', pages: [{ name: 'Details', elements: [{ name: 'Priority', required: false }] }] },
    incoming: { name: 'Travel request', pages: [{ name: 'Details', elements: [{ name: 'Priority', required: true }] }] },
  },
  [APPROVAL]: {
    key: APPROVAL, type: 'form', label: 'Approval', status: 'drifted',
    diff: [{ path: 'description', from: 'edited in test', to: 'v1' }, { path: 'status', from: undefined, to: 'Inactive' }],
    current: { name: 'Approval', description: 'edited in test' },
    incoming: { name: 'Approval', description: 'v1', status: 'Inactive' },
    threeWay: {
      lastPromoted: { name: 'Approval', description: 'v1' }, lastPromotedAt: '2026-10-01T10:00:00Z',
      target: { name: 'Approval', description: 'edited in test' }, incoming: { name: 'Approval', description: 'v1', status: 'Inactive' },
      targetChanges: [{ path: 'description', from: 'v1', to: 'edited in test' }],
    },
  },
};

ITEMS['kapps/hr/kapp'] = {
  key: 'kapps/hr/kapp', type: 'kapp', label: 'HR', status: 'same', diff: [], current: { name: 'HR' }, incoming: { name: 'HR' },
  targetOnlyEntries: [{ key: 'kapps/hr/kapp#categories/old-hardware', collection: 'categories', word: 'category', name: 'old-hardware' }],
};

ITEMS['teams/ops'] = {
  key: 'teams/ops', type: 'team', label: 'Operations', status: 'only-target', diff: [], current: { name: 'Operations' }, incoming: null,
};

const SUGGESTION: SuggestionOut = {
  key: CREATE_OP, label: 'Create ticket', forKey: TRAVEL, kind: 'calls', status: 'new',
  reason: 'Travel request calls operation "Create ticket" on connection "Tickets", which is new in Dev',
};

function setup(opts: { expireC1?: boolean } = {}) {
  let runs = 0;
  const m = mockApi({
    'GET /api/projects/:p': project(),
    'GET /api/projects/:p/history': [historyEvent({ commit: 'abc1234def', type: 'backup', env: 'test', at: '2026-10-08T09:30:00Z' })],
    'POST /api/projects/:p/restore': { status: 202, json: { jobId: 'rst1' } },
    'POST /api/projects/:p/compare': () => ({ status: 202, json: { jobId: `cmp${++runs}` } }),
    'GET /api/jobs/:id/events': { sse: sse([{ type: 'progress', data: { type: 'progress', phase: 'compare', done: 1, total: 2 } }]) },
    'GET /api/jobs/:id': (_c: MockCall, { id }: Record<string, string>) => {
      if (id === 'plan1') return { id, kind: 'plan', status: 'succeeded', createdAt: 'x', result: { planId: 'pl1' } };
      if (id === 'rst1') {
        return {
          id, kind: 'compare', status: 'succeeded', createdAt: 'x',
          result: { ...result('c1'), from: 'test', fromName: 'the backup of 2026-10-08 09:30', sourceCommit: 'abc1234def', preselected: [TRAVEL, APPROVAL] },
        };
      }
      return { id, kind: 'compare', status: 'succeeded', createdAt: 'x', result: id === 'cmp1' ? result('c1') : result('c2', false) };
    },
    'GET /api/projects/:p/compare/:id/tree': (call: MockCall, { id }: Record<string, string>) => {
      const parent = new URLSearchParams(call.search).get('parent') ?? '';
      if (opts.expireC1 && id === 'c1' && parent) return { status: 404, json: { error: { code: 'not_found', message: 'This comparison has expired; run it again.' } } };
      return tree(id === 'c1')[parent] ?? { status: 404, json: { error: { code: 'not_found', message: 'No such tree node.' } } };
    },
    'GET /api/projects/:p/compare/:id/item': (call: MockCall) => ITEMS[new URLSearchParams(call.search).get('key') ?? ''] ?? { status: 404, json: { error: { code: 'not_found', message: 'No such item.' } } },
    'POST /api/projects/:p/compare/:id/suggestions': (call: MockCall) => {
      const selected = (call.body as { selected: string[] }).selected;
      return selected.includes(TRAVEL) && !selected.includes(CREATE_OP) ? [SUGGESTION] : [];
    },
    'POST /api/projects/:p/plans': { status: 202, json: { jobId: 'plan1' } },
    'POST /api/projects/:p/changesets': (call: MockCall) => ({
      status: 201,
      json: { id: 'q4-abc123', ...(call.body as object), description: '', createdAt: '2026-10-08T11:00:00Z', appliedTo: [] },
    }),
  });
  return m;
}

const row = (name: RegExp | string) => screen.getByRole('treeitem', { name: typeof name === 'string' ? new RegExp(name) : name });
const tick = async (user: ReturnType<typeof userEvent.setup>, name: string) => user.click(row(name).querySelector('[data-check]')!);

async function openForms(user: ReturnType<typeof userEvent.setup>) {
  const t = await screen.findByRole('tree', { name: /Differences/ });
  await user.click(await within(t).findByText('Kapps'));
  await user.click(await within(t).findByText('HR'));
  await user.click(await within(t).findByText('Forms'));
  await within(t).findByText('Travel request');
  return t;
}

test('defaults to the active environment and the next one; counts and only differences', async () => {
  const m = setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/compare' });
  await screen.findByRole('tree', { name: /Differences/ });
  expect(m.callsTo('POST', '/api/projects/acme-demo/compare')[0].body).toEqual({ from: 'dev', to: 'test', mode: 'preview', useSnapshots: true });
  const bar = screen.getByRole('group', { name: 'Differences by status' });
  expect(within(bar).getByRole('button', { name: /2 new/ })).toBeInTheDocument();
  expect(within(bar).getByRole('button', { name: /1 only in Test/ })).toBeInTheDocument();
  // Models has nothing but unchanged items: hidden while "Only differences" is on.
  expect(screen.queryByRole('treeitem', { name: /Models/ })).toBeNull();
  expect(row('Teams')).not.toHaveAttribute('aria-checked');
  await userEvent.setup().click(screen.getByRole('switch', { name: 'Only differences' }));
  expect(await screen.findByRole('treeitem', { name: /Models/ })).not.toHaveAttribute('aria-checked');
});

test('drifted items start unchecked; ticking a parent selects only new and changed items', async () => {
  setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/compare' });
  await openForms(user);
  expect(row('Approval')).toHaveAttribute('aria-checked', 'false');
  expect(screen.queryByRole('treeitem', { name: /Unchanged form/ })).toBeNull();

  await tick(user, 'Forms');
  expect(row('Leave request')).toHaveAttribute('aria-checked', 'true');
  expect(row('Travel request')).toHaveAttribute('aria-checked', 'true');
  expect(row('Approval')).toHaveAttribute('aria-checked', 'false');
  expect(row(/^Forms/)).toHaveAttribute('aria-checked', 'true');
  expect(row('Kapps')).toHaveAttribute('aria-checked', 'true');

  await tick(user, 'Leave request');
  expect(row(/^Forms/)).toHaveAttribute('aria-checked', 'mixed');
  expect(row('Kapps')).toHaveAttribute('aria-checked', 'mixed');

  const tray = screen.getByRole('complementary', { name: /Changeset/ });
  expect(within(tray).getByText('Travel request')).toBeInTheDocument();
  expect(within(tray).queryByText('Leave request')).toBeNull();
});

test('adding a suggestion recomputes the suggestions', async () => {
  const m = setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/compare' });
  await openForms(user);
  await tick(user, 'Travel request');
  const tray = screen.getByRole('complementary', { name: /Changeset/ });
  expect(await within(tray).findByText(/which is new in Dev/)).toBeInTheDocument();

  await user.click(within(tray).getByRole('button', { name: 'Add Create ticket' }));
  await waitFor(() => expect(within(tray).queryByText(/which is new in Dev/)).toBeNull());
  const bodies = m.callsTo('POST', '/api/projects/acme-demo/compare/c1/suggestions').map((c) => (c.body as { selected: string[] }).selected);
  expect(bodies).toEqual([[TRAVEL], [TRAVEL, CREATE_OP]]);
  expect(await within(tray).findByText('Create ticket')).toBeInTheDocument();
  expect(within(tray).getByRole('region', { name: 'Operations' })).toBeInTheDocument();
});

test('the tray is pruned when a refreshed comparison no longer has a key', async () => {
  setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/compare' });
  await openForms(user);
  await tick(user, 'Forms');
  const tray = screen.getByRole('complementary', { name: /Changeset/ });
  expect(within(tray).getByText('Leave request')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Run again' }));
  await waitFor(() => expect(within(tray).queryByText('Leave request')).toBeNull());
  expect(within(tray).getByText('Travel request')).toBeInTheDocument();
  expect(await screen.findByText(/no longer differs/)).toBeInTheDocument();
});

test('a drifted item shows the three-way view; Overwrite ticks it and Keep unticks it', async () => {
  setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/compare' });
  const t = await openForms(user);
  await user.click(within(t).getByText('Approval'));
  const drift = await screen.findByRole('region', { name: 'Drift' });
  expect(within(drift).getByRole('table', { name: 'Three-way comparison' })).toHaveTextContent('edited in test');
  expect(within(drift).getByText(/changed in Test/)).toBeInTheDocument();

  await user.click(within(drift).getByRole('button', { name: 'Overwrite' }));
  expect(row('Approval')).toHaveAttribute('aria-checked', 'true');
  const tray = screen.getByRole('complementary', { name: /Changeset/ });
  expect(within(tray).getByText('Overwrite')).toBeInTheDocument();

  await user.click(within(drift).getByRole('button', { name: 'Keep Test' }));
  expect(row('Approval')).toHaveAttribute('aria-checked', 'false');
  expect(within(tray).queryByText('Approval')).toBeNull();
});

test('a changed item shows readable before/after rows and side-by-side JSON', async () => {
  setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/compare' });
  const t = await openForms(user);
  await user.click(within(t).getByText('Travel request'));
  const table = await screen.findByRole('table', { name: 'Changes' });
  expect(table).toHaveTextContent('Page “Details” › Element “Priority” › Required');
  expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['What', 'Test now', 'Dev incoming']);
  await user.click(screen.getByRole('tab', { name: 'Side by side' }));
  expect(await screen.findByRole('region', { name: 'Test now' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Dev incoming' })).toBeInTheDocument();
});

test('Review plan creates a plan job with the selection and opens it', async () => {
  const m = setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/compare' });
  await openForms(user);
  await tick(user, 'Travel request');
  await tick(user, 'Approval');
  await user.click(screen.getByRole('button', { name: /Review plan/ }));
  await waitFor(() => expect(currentLocation()).toBe('/p/acme-demo/plan/pl1'));
  expect(m.callsTo('POST', '/api/projects/acme-demo/plans')[0].body).toEqual({
    to: 'test', from: 'dev', selected: [TRAVEL, APPROVAL], sourceCommit: 'c-dev', resolutions: { [APPROVAL]: 'overwrite' },
  });
});

test('Save as changeset names the selection and pins it to the compared snapshot', async () => {
  const m = setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/compare' });
  await openForms(user);
  await tick(user, 'Travel request');
  await user.click(screen.getByRole('button', { name: /Save as changeset/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Save as changeset' });
  await user.type(within(dialog).getByLabelText('Name'), 'Q4 forms');
  await user.click(within(dialog).getByRole('button', { name: 'Save changeset' }));
  await waitFor(() => expect(m.callsTo('POST', '/api/projects/acme-demo/changesets')).toHaveLength(1));
  expect(m.callsTo('POST', '/api/projects/acme-demo/changesets')[0].body).toEqual({
    name: 'Q4 forms', description: '', from: 'dev', keys: [TRAVEL], sourceCommit: 'c-dev',
  });
  const tray = screen.getByRole('complementary', { name: /Changeset/ });
  expect(await within(tray).findByRole('link', { name: 'Q4 forms' })).toHaveAttribute('href', '/p/acme-demo/changesets/q4-abc123');
});

test('Clear empties the tray and its suggestions', async () => {
  setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/compare' });
  await openForms(user);
  await tick(user, 'Travel request');
  const tray = screen.getByRole('complementary', { name: /Changeset/ });
  expect(await within(tray).findByText(/which is new in Dev/)).toBeInTheDocument();
  await user.click(within(tray).getByRole('button', { name: 'Clear' }));
  expect(within(tray).getByText('Nothing selected yet')).toBeInTheDocument();
  expect(within(tray).queryByText(/which is new in Dev/)).toBeNull();
  expect(screen.queryByRole('region', { name: /Suggested/ })).toBeNull();
});

test('a parent with only drifted items below has a disabled checkbox', async () => {
  setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/compare' });
  await screen.findByRole('tree', { name: /Differences/ });
  const handlers = row('Handlers');
  expect(handlers).toHaveAttribute('aria-checked', 'false');
  expect(handlers).toHaveAttribute('aria-description', expect.stringMatching(/review each one/));
  await tick(user, 'Handlers');
  expect(row('Handlers')).toHaveAttribute('aria-checked', 'false');
  expect(within(screen.getByRole('complementary', { name: /Changeset/ })).getByText('Nothing selected yet')).toBeInTheDocument();
});

test('ticking a parent whose children are not loaded yet loads them and selects new and changed items', async () => {
  setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/compare' });
  await screen.findByRole('tree', { name: /Differences/ });
  await tick(user, 'Kapps');
  const tray = screen.getByRole('complementary', { name: /Changeset/ });
  expect(await within(tray).findByText('Leave request')).toBeInTheDocument();
  expect(within(tray).getByText('Travel request')).toBeInTheDocument();
  expect(within(tray).queryByText('Approval')).toBeNull();
  expect(await screen.findByText('Added 2 items to the changeset')).toBeInTheDocument();
  expect(row('Kapps')).toHaveAttribute('aria-checked', 'true');
});

test('a parent tick honours the status filter', async () => {
  setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/compare' });
  await screen.findByRole('tree', { name: /Differences/ });
  await user.click(within(screen.getByRole('group', { name: 'Differences by status' })).getByRole('button', { name: /1 changed/ }));
  await tick(user, 'Kapps');
  const tray = screen.getByRole('complementary', { name: /Changeset/ });
  expect(await within(tray).findByText('Travel request')).toBeInTheDocument();
  expect(within(tray).queryByText('Leave request')).toBeNull();
});

test('an expired comparison runs again by itself', async () => {
  const m = setup({ expireC1: true });
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/compare' });
  const t = await screen.findByRole('tree', { name: /Differences/ });
  await user.click(within(t).getByText('Kapps'));
  await waitFor(() => expect(m.callsTo('POST', '/api/projects/acme-demo/compare')).toHaveLength(2));
  await openForms(user).catch(() => undefined);
  expect(await screen.findByText('Travel request')).toBeInTheDocument();
});

test('the mode is a radio group moved with the arrow keys', async () => {
  const m = setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/compare' });
  await screen.findByRole('tree', { name: /Differences/ });
  const preview = screen.getByRole('radio', { name: 'Preview' });
  expect(preview).toHaveAttribute('tabindex', '0');
  expect(screen.getByRole('radio', { name: 'Raw' })).toHaveAttribute('tabindex', '-1');
  preview.focus();
  await user.keyboard('{ArrowRight}');
  expect(screen.getByRole('radio', { name: 'Raw' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('radio', { name: 'Raw' })).toHaveFocus();
  await waitFor(() => expect(m.callsTo('POST', '/api/projects/acme-demo/compare').at(-1)!.body).toEqual({ from: 'dev', to: 'test', mode: 'raw' }));
});

test('restore: the backup as From, the live environment as To, touched items preselected by their real status', async () => {
  const m = setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/compare?restore=abc1234def&to=test' });
  await screen.findByRole('tree', { name: /Differences/ });
  expect(m.callsTo('POST', '/api/projects/acme-demo/restore')[0].body).toEqual({ commit: 'abc1234def', mode: 'preview' });
  expect(m.callsTo('POST', '/api/projects/acme-demo/compare')).toHaveLength(0);
  expect(screen.getByTestId('restore-from')).toHaveTextContent(/^Backup of Test \(Oct 8, 2026/);
  const tray = screen.getByRole('complementary', { name: /Changeset/ });
  expect(await within(tray).findByText('Travel request')).toBeInTheDocument();
  // Approval is drifted: it waits for a decision.
  expect(within(tray).queryByText('Approval')).toBeNull();
  expect(screen.queryByRole('button', { name: /Save as changeset/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: /Review plan/ }));
  await waitFor(() => expect(currentLocation()).toBe('/p/acme-demo/plan/pl1'));
  expect(m.callsTo('POST', '/api/projects/acme-demo/plans')[0].body).toEqual({
    to: 'test', from: 'test', selected: [TRAVEL], sourceCommit: 'abc1234def', restore: true,
  });
});

test('an item only in the target has no tick: its own Remove action puts it in the tray\'s removals, which go to the plan and the changeset', async () => {
  const m = setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/compare' });
  const t = await screen.findByRole('tree', { name: /Differences/ });
  await user.click(await within(t).findByText('Teams'));
  await within(t).findByText('Operations');
  expect(row('Operations')).not.toHaveAttribute('aria-checked');
  expect(row('^Teams').querySelector('[data-check]')).toBeNull();
  await user.click(row('Operations'));
  const remove = await screen.findByRole('button', { name: 'Remove from Test' });
  await user.click(remove);
  const tray = screen.getByRole('complementary', { name: /Changeset/ });
  const section = within(tray).getByRole('region', { name: 'Remove from Test' });
  expect(within(section).getByText('Operations')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Keep in Test' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(row('Operations')).getByText('Removing')).toBeInTheDocument();

  await user.click(within(tray).getByRole('button', { name: /Save as changeset/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Save as changeset' });
  await user.type(within(dialog).getByLabelText('Name'), 'Tidy');
  await user.click(within(dialog).getByRole('button', { name: 'Save changeset' }));
  await waitFor(() => expect(m.callsTo('POST', '/api/projects/acme-demo/changesets')).toHaveLength(1));
  expect(m.callsTo('POST', '/api/projects/acme-demo/changesets')[0].body).toEqual({
    name: 'Tidy', description: '', from: 'dev', keys: [], remove: ['teams/ops'], sourceCommit: 'c-dev',
  });

  await user.click(within(tray).getByRole('button', { name: /Review plan/ }));
  await waitFor(() => expect(currentLocation()).toBe('/p/acme-demo/plan/pl1'));
  expect(m.callsTo('POST', '/api/projects/acme-demo/plans')[0].body).toEqual({
    to: 'test', from: 'dev', selected: [], remove: ['teams/ops'], sourceCommit: 'c-dev',
  });
});

test('the tree\'s Remove shortcut marks and unmarks; Keep in the tray takes it out', async () => {
  setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/compare' });
  const t = await screen.findByRole('tree', { name: /Differences/ });
  await user.click(await within(t).findByText('Teams'));
  await within(t).findByText('Operations');
  await user.click(row('Operations').querySelector('[data-remove]')!);
  const tray = screen.getByRole('complementary', { name: /Changeset/ });
  expect(within(tray).getByRole('region', { name: 'Remove from Test' })).toBeInTheDocument();
  await user.click(within(tray).getByRole('button', { name: 'Keep Operations' }));
  expect(within(tray).queryByRole('region', { name: 'Remove from Test' })).toBeNull();
});

test('an item\'s entries only in the target are listed on it, each with its own Remove action that goes into the removals', async () => {
  const m = setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/compare' });
  const t = await screen.findByRole('tree', { name: /Differences/ });
  await user.click(await within(t).findByText('Kapps'));
  await user.click(await within(t).findByText('HR'));
  const only = await screen.findByRole('region', { name: 'Only in Test' });
  expect(only).toHaveTextContent('old-hardware');
  expect(only).toHaveTextContent('category');
  await user.click(within(only).getByRole('button', { name: 'Remove old-hardware from Test' }));
  const tray = screen.getByRole('complementary', { name: /Changeset/ });
  expect(within(within(tray).getByRole('region', { name: 'Remove from Test' })).getByText('old-hardware (category)')).toBeInTheDocument();
  expect(within(only).getByRole('button', { name: 'Keep old-hardware in Test' })).toHaveAttribute('aria-pressed', 'true');
  await user.click(within(tray).getByRole('button', { name: /Review plan/ }));
  await waitFor(() => expect(m.callsTo('POST', '/api/projects/acme-demo/plans')).toHaveLength(1));
  expect(m.callsTo('POST', '/api/projects/acme-demo/plans')[0].body).toEqual({
    to: 'test', from: 'dev', selected: [], remove: ['kapps/hr/kapp#categories/old-hardware'], sourceCommit: 'c-dev',
  });
});
