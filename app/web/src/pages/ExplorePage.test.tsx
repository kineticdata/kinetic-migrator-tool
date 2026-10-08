// Explore: the lazy object tree of an environment's newest snapshot, search,
// a type filter, and the detail pane (Summary / Relationships / JSON /
// History). Secrets show only as "•••• set" / "not set".
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ExploreItem, TreeNode } from '../../../shared/sync-api';
import { AppRoutes } from '../routes';
import { mockApi, sse } from '../test/mock-api';
import { currentLocation, renderWithApp } from '../test/render';
import { historyEvent, project } from '../test/fixtures';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, bottom: 600, right: 320, width: 320, height: 600, toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(320);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const n = (id: string, label: string, kind: TreeNode['kind'], over: Partial<TreeNode> = {}): TreeNode => ({
  id, label, kind, key: id, count: 0, hasChildren: false, ...over,
});

const TREE: Record<string, TreeNode[]> = {
  '': [
    n('space', 'Demo space', 'space'),
    n('group:kapps', 'Kapps', 'group', { key: undefined, count: 3, hasChildren: true }),
    n('group:connections', 'Connections', 'group', { key: undefined, count: 2, hasChildren: true }),
  ],
  'group:kapps': [n('kapps/hr/kapp', 'HR', 'kapp', { count: 2, hasChildren: true })],
  'kapps/hr/kapp': [n('group:kapps/hr/forms', 'Forms', 'group', { key: undefined, count: 1, hasChildren: true })],
  'group:kapps/hr/forms': [n('kapps/hr/forms/leave/form', 'Leave request', 'form')],
  'group:connections': [n('connections/tickets/connection', 'Tickets', 'connection', { count: 1, hasChildren: true })],
};

const FORM: ExploreItem = {
  key: 'kapps/hr/forms/leave/form',
  type: 'form',
  label: 'Leave request',
  summary: {
    title: 'Leave request',
    subtitle: 'Form in kapp hr',
    sections: [
      { heading: 'Overview', rows: [{ label: 'Status', value: 'Active' }, { label: 'Fields', value: 2 }] },
      { heading: 'Fields', rows: [{ label: 'Start date', value: 'date, required' }, { label: 'Notes', value: 'text' }] },
      { heading: 'Integrations', items: ['Tickets › Create ticket'] },
    ],
  },
  relationships: {
    uses: [{ key: 'connections/tickets/connection', label: 'Tickets', kind: 'connection', reason: 'calls an operation of' }],
    usedBy: [],
  },
  json: { slug: 'leave', name: 'Leave request', pages: [{ name: 'Page 1', elements: [] }] },
  history: [
    { commit: 'c-dev', at: '2026-10-08T10:00:00Z', message: 'Snapshot of dev' },
    { commit: 'c-run', at: '2026-10-07T09:00:00Z', message: "Applied 'Q4 forms' to dev" },
  ],
};

const CONNECTION: ExploreItem = {
  key: 'connections/tickets/connection',
  type: 'connection',
  label: 'Tickets',
  summary: {
    title: 'Tickets',
    subtitle: 'Connection',
    sections: [
      { heading: 'Overview', rows: [{ label: 'Type', value: 'http' }, { label: 'Base URL', value: 'https://api.example.com' }] },
      { heading: 'Authentication', rows: [{ label: 'password', value: '•••• set' }, { label: 'token', value: 'not set' }, { label: 'username', value: 'svc-user' }] },
    ],
  },
  relationships: { uses: [], usedBy: [{ key: 'kapps/hr/forms/leave/form', label: 'Leave request', kind: 'form', reason: 'is called by' }] },
  json: { name: 'Tickets', config: { baseUrl: 'https://api.example.com', auth: { authType: 'basic', username: 'svc-user' } } },
  history: [],
};

function setup() {
  let treeCalls = 0;
  const m = mockApi({
    'GET /api/projects/:p': project(),
    'GET /api/projects/:p/history': [
      historyEvent({ id: 'h1', commit: 'c-run', type: 'applied', title: "Applied 'Q4 forms' to Dev", env: 'dev', status: 'applied', at: '2026-10-07T09:00:00Z' }),
    ],
    'GET /api/projects/:p/explore/:env/tree': (call: { search: string }) => {
      treeCalls++;
      const parent = new URLSearchParams(call.search).get('parent') ?? '';
      return TREE[parent] ?? { status: 404, json: { error: { code: 'not_found', message: 'No such tree node.' } } };
    },
    'GET /api/projects/:p/explore/:env/item': (call: { search: string }) => {
      const key = new URLSearchParams(call.search).get('key');
      return key === FORM.key ? FORM : key === CONNECTION.key ? CONNECTION : { status: 404, json: { error: { code: 'not_found', message: 'No such item in this snapshot.' } } };
    },
    'GET /api/projects/:p/search/:env': (call: { search: string }) => {
      const q = new URLSearchParams(call.search).get('q');
      return q === 'start'
        ? { results: [{ key: FORM.key, label: 'Leave request', kind: 'form', match: 'field', field: 'Start date' }], truncated: false }
        : { results: [], truncated: false };
    },
    'POST /api/projects/:p/snapshots': { status: 202, json: { jobId: 'snap1' } },
    'GET /api/jobs/snap1/events': { sse: sse([{ type: 'progress', data: { type: 'progress', phase: 'export', done: 1, total: 4 } }]) },
    'GET /api/jobs/snap1': { id: 'snap1', kind: 'snapshot', status: 'succeeded', createdAt: 'x', result: { env: 'dev', commit: 'c2', total: 5, counts: {}, drifted: [] } },
  });
  return { m, treeCalls: () => treeCalls };
}

test('opens groups lazily and shows an item’s summary with a field table', async () => {
  const { m } = setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/explore/dev' });
  const tree = await screen.findByRole('tree', { name: 'Items in Dev' });
  // Only the root is loaded up front.
  expect(m.calls.filter((c) => c.path.endsWith('/tree')).map((c) => c.search)).toEqual(['']);
  await user.click(within(tree).getByText('Kapps'));
  // HR is an item with children: clicking it selects and opens it.
  await user.click(await within(tree).findByText('HR'));
  await user.click(await within(tree).findByText('Forms'));
  expect(m.calls.filter((c) => c.path.endsWith('/tree')).map((c) => new URLSearchParams(c.search).get('parent')))
    .toEqual([null, 'group:kapps', 'kapps/hr/kapp', 'group:kapps/hr/forms']);
  await user.click(await within(tree).findByText('Leave request'));
  expect(currentLocation()).toContain('item=kapps%2Fhr%2Fforms%2Fleave%2Fform');

  const pane = await screen.findByRole('region', { name: 'Leave request' });
  expect(within(pane).getByText('Form in kapp hr')).toBeInTheDocument();
  const fields = within(pane).getByRole('table', { name: 'Fields' });
  expect(within(fields).getByRole('row', { name: /Start date date Required/ })).toBeInTheDocument();
  expect(within(pane).getByText('Tickets › Create ticket')).toBeInTheDocument();
});

test('a secret shows as "•••• set", never a value', async () => {
  setup();
  renderWithApp(<AppRoutes />, { route: `/p/acme-demo/explore/dev?item=${encodeURIComponent(CONNECTION.key)}` });
  const pane = await screen.findByRole('region', { name: 'Tickets' });
  const auth = within(pane).getByRole('table', { name: 'Authentication' });
  expect(within(auth).getByRole('row', { name: /password/ })).toHaveTextContent('•••• set');
  expect(within(auth).getByRole('row', { name: /token/ })).toHaveTextContent('not set');
  expect(within(auth).getByRole('row', { name: /username/ })).toHaveTextContent('svc-user');
});

test('relationships are clickable and open the related item', async () => {
  setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: `/p/acme-demo/explore/dev?item=${encodeURIComponent(FORM.key)}` });
  const pane = await screen.findByRole('region', { name: 'Leave request' });
  await user.click(within(pane).getByRole('tab', { name: /Relationships/ }));
  const uses = within(pane).getByRole('list', { name: 'Uses' });
  expect(within(pane).getByText(/Nothing uses this item/)).toBeInTheDocument();
  await user.click(within(uses).getByRole('button', { name: /Tickets/ }));
  expect(await screen.findByRole('region', { name: 'Tickets' })).toBeInTheDocument();
  expect(currentLocation()).toContain('item=connections%2Ftickets%2Fconnection');
});

test('JSON tab collapses and copies; History lists snapshots and promotions', async () => {
  setup();
  const user = userEvent.setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  renderWithApp(<AppRoutes />, { route: `/p/acme-demo/explore/dev?item=${encodeURIComponent(FORM.key)}` });
  const pane = await screen.findByRole('region', { name: 'Leave request' });

  await user.click(within(pane).getByRole('tab', { name: 'JSON' }));
  const json = within(pane).getByRole('region', { name: 'JSON' });
  expect(json).toHaveTextContent('"slug"');
  expect(json).toHaveTextContent('"leave"');
  const pages = within(json).getByRole('button', { name: /pages/ });
  expect(pages).toHaveAttribute('aria-expanded', 'true');
  await user.click(pages);
  expect(pages).toHaveAttribute('aria-expanded', 'false');
  expect(json).not.toHaveTextContent('Page 1');
  await user.click(within(pane).getByRole('button', { name: 'Copy JSON' }));
  expect(writeText).toHaveBeenCalledWith(JSON.stringify(FORM.json, null, 2));

  await user.click(within(pane).getByRole('tab', { name: /History/ }));
  const list = within(pane).getByRole('list', { name: 'History' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  expect(within(list).getByText("Applied 'Q4 forms' to Dev")).toBeInTheDocument();
  expect(within(list).getByText('Promotion')).toBeInTheDocument();
  expect(within(list).getByText('Snapshot')).toBeInTheDocument();
});

test('search shows matches (with the matching field) and opens one', async () => {
  const { m } = setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/explore/dev' });
  await screen.findByRole('tree', { name: 'Items in Dev' });
  await user.type(screen.getByRole('searchbox', { name: 'Search items' }), 'start');
  const results = await screen.findByRole('tree', { name: 'Search results' });
  expect(await within(results).findByText('Leave request')).toBeInTheDocument();
  expect(within(results).getByText(/field Start date/)).toBeInTheDocument();
  expect(m.calls.filter((c) => c.path.endsWith('/search/dev')).at(-1)?.search).toBe('?q=start');
  await user.click(within(results).getByText('Leave request'));
  expect(await screen.findByRole('region', { name: 'Leave request' })).toBeInTheDocument();
  // Escape clears the search and brings the tree back.
  fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search items' }), { key: 'Escape' });
  expect(await screen.findByRole('tree', { name: 'Items in Dev' })).toBeInTheDocument();
});

test('the type filter narrows the tree to one section', async () => {
  setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/explore/dev' });
  const tree = await screen.findByRole('tree', { name: 'Items in Dev' });
  expect(within(tree).getByText('Kapps')).toBeInTheDocument();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'group:connections');
  await waitFor(() => expect(within(tree).queryByText('Kapps')).toBeNull());
  expect(within(tree).getByText('Connections')).toBeInTheDocument();
});

test('refresh snapshot shows live progress and reloads the project', async () => {
  const { m } = setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/explore/dev' });
  await screen.findByRole('tree', { name: 'Items in Dev' });
  const before = m.callsTo('GET', '/api/projects/acme-demo').length;
  await user.click(screen.getByRole('button', { name: 'Refresh snapshot' }));
  expect(m.callsTo('POST', '/api/projects/acme-demo/snapshots')[0].body).toEqual({ env: 'dev' });
  await waitFor(() => expect(m.callsTo('GET', '/api/projects/acme-demo').length).toBeGreaterThan(before));
});

test('an environment without a snapshot offers to take one', async () => {
  setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/explore/prod' });
  expect(await screen.findByText('No snapshot of Prod yet')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Take snapshot' })).toBeInTheDocument();
});

test('switching environment during a snapshot shows that environment’s own state', async () => {
  // The job keeps running: progress arrives over SSE and no end follows.
  const user = userEvent.setup();
  const running = { id: 'snap1', kind: 'snapshot', status: 'running', createdAt: 'x' };
  mockApi({
    'GET /api/projects/:p': project(),
    'GET /api/projects/:p/history': [],
    'GET /api/projects/:p/explore/:env/tree': (call: { search: string }) => TREE[new URLSearchParams(call.search).get('parent') ?? ''] ?? [],
    'POST /api/projects/:p/snapshots': { status: 202, json: { jobId: 'snap1' } },
    'GET /api/jobs/snap1/events': { sse: sse([{ type: 'progress', data: { type: 'progress', phase: 'export', done: 1, total: 4 } }], null) },
    'GET /api/jobs/snap1': running,
  });
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/explore/dev' });
  await screen.findByRole('tree', { name: 'Items in Dev' });
  await user.click(screen.getByRole('button', { name: 'Refresh snapshot' }));
  // Live progress from the SSE events.
  expect(await screen.findByText('1 of 4')).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: 'Snapshot of Dev' })).toHaveAttribute('aria-valuenow', '25');
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();

  await user.click(within(screen.getByRole('navigation', { name: 'Environments' })).getByRole('link', { name: /Test/ }));
  expect(await screen.findByRole('heading', { name: 'Explore Test' })).toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Refresh snapshot' })).toBeInTheDocument();
});

test('a child list that fails to load says "Could not load"', async () => {
  setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/explore/dev' });
  const tree = await screen.findByRole('tree', { name: 'Items in Dev' });
  await user.click(within(tree).getByText('Connections'));
  await user.click(await within(tree).findByText('Tickets'));
  expect(await within(tree).findByText('Could not load')).toBeInTheDocument();
});

test('a stale ?item= says it is not in this snapshot', async () => {
  setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/explore/dev?item=kapps%2Fgone%2Fkapp' });
  expect(await screen.findByText('Not in this snapshot')).toBeInTheDocument();
  expect(screen.getByText('No such item in this snapshot.')).toBeInTheDocument();
});

test('an item opened by link is revealed in the tree', async () => {
  setup();
  renderWithApp(<AppRoutes />, { route: `/p/acme-demo/explore/dev?item=${encodeURIComponent(FORM.key)}` });
  const tree = await screen.findByRole('tree', { name: 'Items in Dev' });
  const row = await within(tree).findByRole('treeitem', { name: /Leave request/ });
  expect(row).toHaveAttribute('aria-selected', 'true');
  expect(row).toHaveAttribute('aria-level', '4');
  expect(tree.getAttribute('aria-activedescendant')).toBe(row.id);
});

test('previous search results stay visible while typing more', async () => {
  setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/explore/dev' });
  await screen.findByRole('tree', { name: 'Items in Dev' });
  const box = screen.getByRole('searchbox', { name: 'Search items' });
  await user.type(box, 'start');
  const results = await screen.findByRole('tree', { name: 'Search results' });
  expect(await within(results).findByText('Leave request')).toBeInTheDocument();
  await user.type(box, 'x');
  expect(screen.queryByText('Searching…')).toBeNull();
  expect(within(screen.getByRole('tree', { name: 'Search results' })).getByText('Leave request')).toBeInTheDocument();
  expect(await screen.findByText('No matches')).toBeInTheDocument();
});
