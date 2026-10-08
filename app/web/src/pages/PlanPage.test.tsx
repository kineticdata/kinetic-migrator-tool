// Plan & apply: Review → Environment values → Confirm → Apply. Each step
// blocks until its rules are met, secrets never outlive the request, and the
// apply checklist follows the streamed job events.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { ApplyResult, PlanResult } from '../../../shared/sync-api';
import { Route, Routes } from 'react-router';
import { PlanPage } from './PlanPage';
import { ProjectLayout } from './ProjectLayout';
import { mockApi, sse } from '../test/mock-api';
import { currentLocation, renderWithApp } from '../test/render';
import { env, project } from '../test/fixtures';

// The plan screen inside the project frame (with a stand-in Compare).
function AppRoutes() {
  return (
    <Routes>
      <Route path="/p/:projectId" element={<ProjectLayout />}>
        <Route path="plan/:planId" element={<PlanPage />} />
        <Route path="compare" element={<p>Compare screen</p>} />
      </Route>
    </Routes>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const CONN = 'connections/tickets/connection';
const FORM = 'kapps/hr/forms/leave/form';
const HANDLER = 'handlers/smtp_send_v1/handler';
const KAPP = 'kapps/hr/kapp';
const SECRET = 'planted-secret-value-7f3a';

function plan(over: Partial<PlanResult> = {}): PlanResult {
  return {
    planId: 'pl1', name: '3 items from Dev', to: 'test', from: 'dev', changesetId: null, sourceCommit: 'c-dev',
    items: [
      { key: CONN, type: 'connections', label: 'Tickets', action: 'create', drift: false, diff: [] },
      { key: HANDLER, type: 'handlers', label: 'SMTP Send', action: 'create', drift: false, diff: [] },
      { key: FORM, type: 'forms', label: 'Leave request', action: 'update', drift: false, diff: [{ path: 'description', from: 'Old text', to: 'New text' }] },
      { key: KAPP, type: 'kapps', label: 'HR', action: 'unchanged', drift: false, diff: [] },
    ],
    counts: { create: 2, update: 1, unchanged: 1, manual: 0, 'skip-drift': 0, delete: 0 },
    needsAttention: [
      { id: `handler:${HANDLER}`, kind: 'handler', key: HANDLER, message: 'Installs handler SMTP Send in Test.' },
      { id: `connection-secrets:${CONN}`, kind: 'connection-secrets', key: CONN, message: 'Connection Tickets will be created without credentials unless you enter them.' },
    ],
    environmentValues: [
      { id: `${CONN}#baseUrl`, key: CONN, path: 'baseUrl', label: 'Tickets › Base URL', from: 'https://api.example.com', to: null, origin: 'environment', required: true },
      { id: `${KAPP}#attributes[Web Server Url]`, key: KAPP, path: 'attributes[Web Server Url]', label: 'HR › Web Server Url', from: 'https://dev.your-space.kinops.io', to: 'https://test.your-space.kinops.io', origin: 'attribute', required: false },
    ],
    secretsNeeded: [{ id: 'secret/tickets__password', key: CONN, scope: 'secret', name: 'tickets__password', label: 'Tickets › Password', has: false }],
    errors: [],
    warnings: [],
    ...over,
  };
}

const simple = (over: Partial<PlanResult> = {}) => plan({ needsAttention: [], environmentValues: [], secretsNeeded: [], ...over });

// A job event stream the test feeds frame by frame.
function liveStream() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
  let seq = 0;
  const enc = new TextEncoder();
  return {
    response: () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    push: (data: Record<string, unknown>) => ctrl.enqueue(enc.encode(`id: ${++seq}\nevent: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`)),
    end: (status: string) => {
      ctrl.enqueue(enc.encode(`event: end\ndata: ${JSON.stringify({ status })}\n\n`));
      ctrl.close();
    },
  };
}

function setup(p: PlanResult, opts: { readOnly?: boolean; applyJobs?: Array<{ id: string; events?: string | (() => Response); result?: ApplyResult; status?: string; error?: string }> } = {}) {
  const jobs = opts.applyJobs ?? [{ id: 'a1', result: { runId: 'r1', status: 'applied', commit: 'c-run', backupCommit: 'c-backup', done: 3, error: null } }];
  let started = 0;
  const routes: Record<string, unknown> = {
    'GET /api/projects/:p': project({ environments: [env('dev'), env('test', { readOnly: Boolean(opts.readOnly) }), env('prod', { readOnly: true })] }),
    'GET /api/projects/:p/history': [],
    'GET /api/projects/:p/plans/:id': (_c: unknown, { id }: Record<string, string>) => (id === p.planId ? p : { status: 404, json: { error: { code: 'not_found', message: 'This plan has expired; plan again.' } } }),
    'POST /api/projects/:p/plans/:id/apply': () => ({ status: 202, json: { jobId: jobs[Math.min(started++, jobs.length - 1)].id } }),
  };
  for (const j of jobs) {
    routes[`GET /api/jobs/${j.id}/events`] = typeof j.events === 'function' ? j.events : { sse: j.events ?? sse([]) };
    // An apply that ends with a result succeeds whatever its outcome; a job
    // that failed or was cancelled before reporting has only an error.
    routes[`GET /api/jobs/${j.id}`] = {
      id: j.id, kind: 'apply', status: j.status ?? 'succeeded', createdAt: 'x',
      ...(j.result ? { result: j.result } : {}), ...(j.error ? { error: { code: 'failed', message: j.error } } : {}),
    };
  }
  return mockApi(routes);
}

const next = () => screen.getByRole('button', { name: /^Next/ });

async function toConfirm(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: '3 items from Dev' });
  await user.click(next());
  await user.click(next());
  expect(screen.getByRole('heading', { name: 'Confirm' })).toBeInTheDocument();
}

test('Review lists counts and items; Next waits until every attention item is ticked', async () => {
  setup(plan());
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/plan/pl1' });
  expect(await screen.findByRole('heading', { name: '3 items from Dev' })).toBeInTheDocument();
  const steps = screen.getByRole('navigation', { name: 'Steps' });
  expect(within(steps).getByText('Review').closest('li')).toHaveAttribute('aria-current', 'step');

  const counts = screen.getByRole('region', { name: 'Summary' });
  expect(counts).toHaveTextContent('2create');
  expect(counts).toHaveTextContent('1update');
  expect(counts).toHaveTextContent('1no change');

  // Per-item changes expand.
  const items = screen.getByRole('region', { name: 'Items' });
  await user.click(within(items).getByRole('button', { name: /Leave request/ }));
  expect(within(items).getByRole('table', { name: 'Changes' })).toHaveTextContent('New text');

  const attention = screen.getByRole('region', { name: 'Needs attention' });
  const boxes = within(attention).getAllByRole('checkbox');
  expect(boxes).toHaveLength(2);
  expect(next()).toBeDisabled();
  await user.click(boxes[0]);
  expect(next()).toBeDisabled();
  await user.click(within(attention).getByRole('checkbox', { name: /created without credentials/ }));
  expect(next()).toBeEnabled();
  await user.click(next());
  expect(screen.getByRole('heading', { name: 'Environment values' })).toBeInTheDocument();
});

test('plan errors block with a plain fix', async () => {
  setup(simple({ errors: ['Routine Notify Manager is used by exported workflows but does not exist in the target'] }));
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/plan/pl1' });
  const problems = await screen.findByRole('region', { name: 'Problems' });
  expect(problems).toHaveTextContent('Routine Notify Manager is used by exported workflows');
  expect(problems).toHaveTextContent('Add the routine to the changeset, or create it in Test first');
  expect(next()).toBeDisabled();
});

test('required values block Confirm; confirm needs the exact name; secrets are sent once and not kept', async () => {
  const m = setup(plan());
  const user = userEvent.setup();
  const { client } = renderWithApp(<AppRoutes />, { route: '/p/acme-demo/plan/pl1' });
  await screen.findByRole('heading', { name: '3 items from Dev' });
  for (const box of within(screen.getByRole('region', { name: 'Needs attention' })).getAllByRole('checkbox')) await user.click(box);
  await user.click(next());

  const values = screen.getByRole('region', { name: 'Environment values' });
  expect(within(values).getByText('https://api.example.com')).toBeInTheDocument();
  expect(within(values).getByText('Required')).toBeInTheDocument();
  expect(next()).toBeDisabled();
  await user.type(within(values).getByLabelText(/Tickets › Base URL/), 'https://api.test.example.com');
  expect(next()).toBeEnabled();

  const secrets = screen.getByRole('region', { name: 'Secrets needed' });
  const secretBox = within(secrets).getByLabelText('Tickets › Password');
  expect(secretBox).toHaveAttribute('type', 'password');
  await user.type(secretBox, SECRET);
  await user.click(within(secrets).getByRole('checkbox', { name: 'Remember in keychain' }));
  await user.click(next());

  expect(screen.getByText(/A backup snapshot of Test is taken first/)).toBeInTheDocument();
  const apply = screen.getByRole('button', { name: 'Apply to Test' });
  expect(apply).toBeDisabled();
  const confirm = screen.getByLabelText(/Type test to confirm/);
  await user.type(confirm, 'Test');
  expect(apply).toBeDisabled();
  await user.clear(confirm);
  await user.type(confirm, 'test');
  expect(apply).toBeEnabled();
  await user.click(apply);

  await waitFor(() => expect(m.callsTo('POST', '/api/projects/acme-demo/plans/pl1/apply')).toHaveLength(1));
  expect(m.callsTo('POST', '/api/projects/acme-demo/plans/pl1/apply')[0].body).toEqual({
    acknowledgements: [`handler:${HANDLER}`, `connection-secrets:${CONN}`],
    values: { [CONN]: { baseUrl: 'https://api.test.example.com' } },
    secrets: { 'secret/tickets__password': SECRET },
    remember: true,
    confirm: 'test',
  });
  expect(await screen.findByRole('heading', { name: 'Applied to Test' })).toBeInTheDocument();
  // Not in any cache, and not on screen.
  const cached = JSON.stringify([client.getQueryCache().getAll().map((q) => q.state.data), client.getMutationCache().getAll().map((x) => x.state.variables)]);
  expect(cached).not.toContain(SECRET);
  expect(document.body.innerHTML).not.toContain(SECRET);
});

test('Back keeps what was entered, except nothing needs re-ticking', async () => {
  setup(plan());
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/plan/pl1' });
  await screen.findByRole('heading', { name: '3 items from Dev' });
  for (const box of within(screen.getByRole('region', { name: 'Needs attention' })).getAllByRole('checkbox')) await user.click(box);
  await user.click(next());
  await user.type(screen.getByLabelText(/Tickets › Base URL/), 'https://api.test.example.com');
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(next()).toBeEnabled();
  await user.click(next());
  expect(screen.getByLabelText(/Tickets › Base URL/)).toHaveValue('https://api.test.example.com');
});

test('the apply checklist follows the streamed events, grouped by phase', async () => {
  const stream = liveStream();
  setup(simple(), { applyJobs: [{ id: 'a1', events: () => stream.response(), result: { runId: 'r1', status: 'applied', commit: 'c-run', backupCommit: 'c-backup', done: 3, error: null } }] });
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/plan/pl1' });
  await toConfirm(user);
  await user.type(screen.getByLabelText(/Type test to confirm/), 'test');
  await user.click(screen.getByRole('button', { name: 'Apply to Test' }));

  const progress = await screen.findByRole('region', { name: 'Progress' });
  const groups = within(progress).getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
  expect(groups).toEqual(['Backup', 'Connections', 'Handlers', 'Forms']);
  expect(within(progress).getByRole('listitem', { name: 'Tickets: Pending' })).toBeInTheDocument();

  await act(async () => {
    stream.push({ type: 'step', step: 'backup', status: 'running' });
  });
  expect(await within(progress).findByRole('listitem', { name: 'Backup of Test: Running' })).toBeInTheDocument();
  await act(async () => {
    stream.push({ type: 'step', step: 'backup', status: 'done' });
    stream.push({ type: 'item', key: CONN, status: 'running' });
  });
  expect(await within(progress).findByRole('listitem', { name: 'Tickets: Running' })).toBeInTheDocument();
  expect(within(progress).getByRole('listitem', { name: 'Backup of Test: Done' })).toBeInTheDocument();
  await act(async () => {
    stream.push({ type: 'item', key: CONN, status: 'done' });
    stream.push({ type: 'item', key: HANDLER, status: 'skipped' });
    stream.push({ type: 'item', key: FORM, status: 'done' });
    stream.end('succeeded');
  });
  expect(await screen.findByRole('heading', { name: 'Applied to Test' })).toBeInTheDocument();
  expect(within(progress).getByRole('listitem', { name: 'Tickets: Done' })).toBeInTheDocument();
  expect(within(progress).getByRole('listitem', { name: 'SMTP Send: Skipped' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View in History' })).toHaveAttribute('href', '/p/acme-demo/history');
});

test('a failed apply shows the error, and Resume applies again; View backup and Restore… link to the backup', async () => {
  const failed = sse([
    { type: 'step', data: { type: 'step', step: 'backup', status: 'done' } },
    { type: 'item', data: { type: 'item', key: CONN, status: 'done' } },
    { type: 'item', data: { type: 'item', key: HANDLER, status: 'running' } },
    { type: 'item', data: { type: 'item', key: HANDLER, status: 'failed', message: 'The Kinetic Platform returned an error (500).' } },
  ]);
  const resumed = sse([
    { type: 'item', data: { type: 'item', key: HANDLER, status: 'done' } },
    { type: 'item', data: { type: 'item', key: FORM, status: 'done' } },
  ]);
  const m = setup(simple(), {
    applyJobs: [
      { id: 'a1', events: failed, result: { runId: 'r1', status: 'partial', commit: 'c-run', backupCommit: 'c-backup', done: 1, error: `${HANDLER}: The Kinetic Platform returned an error (500).` } },
      { id: 'a2', events: resumed, result: { runId: 'r2', status: 'applied', commit: 'c-run2', backupCommit: 'c-backup2', done: 2, error: null } },
    ],
  });
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/plan/pl1' });
  await toConfirm(user);
  await user.type(screen.getByLabelText(/Type test to confirm/), 'test');
  await user.click(screen.getByRole('button', { name: 'Apply to Test' }));

  const alert = await screen.findByRole('alert');
  expect(screen.getByRole('heading', { name: 'Partly applied to Test' })).toBeInTheDocument();
  expect(alert).toHaveTextContent('Stopped after 1 change');
  expect(alert).toHaveTextContent('The Kinetic Platform returned an error (500).');
  const progress = screen.getByRole('region', { name: 'Progress' });
  expect(within(progress).getByRole('listitem', { name: /SMTP Send: Failed/ })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View backup' })).toHaveAttribute('href', '/p/acme-demo/history?commit=c-backup');
  expect(screen.getByRole('link', { name: 'Restore…' })).toHaveAttribute('href', '/p/acme-demo/compare?restore=c-backup&to=test');

  await user.click(screen.getByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(m.callsTo('POST', '/api/projects/acme-demo/plans/pl1/apply')).toHaveLength(2));
  expect(m.callsTo('POST', '/api/projects/acme-demo/plans/pl1/apply')[1].body).toEqual({ acknowledgements: [], confirm: 'test' });
  expect(await screen.findByRole('heading', { name: 'Applied to Test' })).toBeInTheDocument();
  // What the first run finished stays done.
  expect(within(progress).getByRole('listitem', { name: 'Tickets: Done' })).toBeInTheDocument();
  expect(within(progress).getByRole('listitem', { name: 'SMTP Send: Done' })).toBeInTheDocument();
});

test('an item changed in the target since review is shown skipped with its reason, and the run as partly applied', async () => {
  const reason = 'Changed in Test since you reviewed it — not applied.';
  const events = sse([
    { type: 'step', data: { type: 'step', step: 'backup', status: 'done' } },
    { type: 'item', data: { type: 'item', key: HANDLER, status: 'skipped', message: reason } },
    { type: 'item', data: { type: 'item', key: CONN, status: 'done' } },
    { type: 'item', data: { type: 'item', key: FORM, status: 'done' } },
  ]);
  setup(simple(), {
    applyJobs: [{ id: 'a1', events, result: { runId: 'r1', status: 'partial', commit: 'c-run', backupCommit: 'c-backup', done: 2, error: '1 item was not applied (see the list below). Plan again to review it.' } }],
  });
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/plan/pl1' });
  await toConfirm(user);
  await user.type(screen.getByLabelText(/Type test to confirm/), 'test');
  await user.click(screen.getByRole('button', { name: 'Apply to Test' }));

  const alert = await screen.findByRole('alert');
  expect(screen.getByRole('heading', { name: 'Partly applied to Test' })).toBeInTheDocument();
  expect(alert).toHaveTextContent('2 changes applied. 1 item was not applied');
  const progress = screen.getByRole('region', { name: 'Progress' });
  expect(within(progress).getByRole('listitem', { name: `SMTP Send: Skipped — ${reason}` })).toBeInTheDocument();
  expect(within(progress).getByText(reason)).toBeInTheDocument();
});

test('a protected target cannot be applied to', async () => {
  setup(simple(), { readOnly: true });
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/plan/pl1' });
  expect(await screen.findByText(/Test is protected/)).toBeInTheDocument();
  await toConfirm(user);
  await user.type(screen.getByLabelText(/Type test to confirm/), 'test');
  expect(screen.getByRole('button', { name: 'Apply to Test' })).toBeDisabled();
});

test('an expired plan points back to Compare', async () => {
  setup(simple());
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/plan/gone' });
  expect(await screen.findByText('This plan has expired; plan again.')).toBeInTheDocument();
  await user.click(screen.getByRole('link', { name: 'Back to Compare' }));
  expect(currentLocation()).toBe('/p/acme-demo/compare');
});

const go = async (user: ReturnType<typeof userEvent.setup>) => {
  await toConfirm(user);
  await user.type(screen.getByLabelText(/Type test to confirm/), 'test');
  await user.click(screen.getByRole('button', { name: 'Apply to Test' }));
};

test('an apply cancelled mid-run says so, keeps what it did and links to the backup', async () => {
  setup(simple(), {
    applyJobs: [{
      id: 'a1',
      events: sse([
        { type: 'step', data: { type: 'step', step: 'backup', status: 'done' } },
        { type: 'item', data: { type: 'item', key: CONN, status: 'done' } },
        { type: 'item', data: { type: 'item', key: HANDLER, status: 'running' } },
      ]),
      result: { runId: 'r1', status: 'cancelled', commit: 'c-run', backupCommit: 'c-backup', done: 1, error: 'The apply was cancelled.' },
    }],
  });
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/plan/pl1' });
  await go(user);
  expect(await screen.findByRole('heading', { name: 'Cancelled applying to Test' })).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Cancelled after 1 change.');
  const progress = screen.getByRole('region', { name: 'Progress' });
  expect(within(progress).getByRole('listitem', { name: 'Tickets: Done' })).toBeInTheDocument();
  expect(within(progress).getByRole('listitem', { name: /SMTP Send: Skipped — Cancelled before it finished/ })).toBeInTheDocument();
  expect(within(progress).queryAllByRole('listitem', { name: /: Running/ })).toHaveLength(0);
  expect(within(progress).getByRole('status')).toHaveTextContent('3 of 4 done');
  expect(screen.getByRole('link', { name: 'View backup' })).toHaveAttribute('href', '/p/acme-demo/history?commit=c-backup');
  expect(screen.getByRole('link', { name: 'Restore…' })).toBeInTheDocument();
});

test('a job that failed without a result: Failed, done counted from events, running rows stopped; Resume never carries them', async () => {
  const m = setup(simple(), {
    applyJobs: [
      {
        id: 'a1',
        events: sse([
          { type: 'step', data: { type: 'step', step: 'backup', status: 'done' } },
          { type: 'item', data: { type: 'item', key: CONN, status: 'done' } },
          { type: 'item', data: { type: 'item', key: HANDLER, status: 'running' } },
        ], 'failed'),
        status: 'failed', error: 'Lost contact with the target.',
      },
      {
        id: 'a2',
        events: sse([
          { type: 'step', data: { type: 'step', step: 'backup', status: 'done' } },
          { type: 'item', data: { type: 'item', key: HANDLER, status: 'skipped', message: 'Already up to date in Test.' } },
          { type: 'item', data: { type: 'item', key: FORM, status: 'done' } },
        ]),
        result: { runId: 'r2', status: 'applied', commit: 'c2', backupCommit: 'c-b2', done: 1, error: null },
      },
    ],
  });
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/plan/pl1' });
  await go(user);
  expect(await screen.findByRole('heading', { name: 'Failed to apply to Test' })).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Stopped after 1 change. Lost contact with the target.');
  const progress = screen.getByRole('region', { name: 'Progress' });
  expect(within(progress).getByRole('listitem', { name: /SMTP Send: Failed — Stopped before it finished/ })).toBeInTheDocument();
  // No result, so no known backup.
  expect(screen.queryByRole('link', { name: 'View backup' })).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(m.callsTo('POST', '/api/projects/acme-demo/plans/pl1/apply')).toHaveLength(2));
  expect(await screen.findByRole('heading', { name: 'Applied to Test' })).toBeInTheDocument();
  expect(within(progress).getByRole('listitem', { name: 'Tickets: Done' })).toBeInTheDocument();
  // The handler the resumed run found already as wanted is no longer running.
  expect(within(progress).getByRole('listitem', { name: 'SMTP Send: Skipped — Already up to date in Test.' })).toBeInTheDocument();
  expect(within(progress).queryAllByRole('listitem', { name: /: Running/ })).toHaveLength(0);
});

test('a job cancelled before reporting is shown as cancelled', async () => {
  setup(simple(), { applyJobs: [{ id: 'a1', events: sse([{ type: 'step', data: { type: 'step', step: 'backup', status: 'running' } }], 'cancelled'), status: 'cancelled' }] });
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/plan/pl1' });
  await go(user);
  expect(await screen.findByRole('heading', { name: 'Cancelled applying to Test' })).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Nothing was applied.');
  expect(within(screen.getByRole('region', { name: 'Progress' })).getByRole('listitem', { name: /Backup of Test: Skipped/ })).toBeInTheDocument();
});

test('kept drift is not listed; preflight warnings must be ticked; a filled value takes care of its warning', async () => {
  const ATTR = `${KAPP}#attributes.Web Server Url`;
  setup(simple({
    items: [
      { key: FORM, type: 'forms', label: 'Leave request', action: 'skip-drift', drift: true, diff: [] },
      { key: CONN, type: 'connections', label: 'Tickets', action: 'create', drift: false, diff: [] },
    ],
    needsAttention: [{ id: `drift:${FORM}`, kind: 'drift', key: FORM, message: 'Leave request was changed in Test since it was last promoted.' }],
    environmentValues: [{ id: ATTR, key: KAPP, path: 'attributes.Web Server Url', label: 'Web Server Url', from: ['https://dev.example.com'], to: null, origin: 'attribute', required: false }],
    warnings: [
      `${KAPP}: environment-bound attribute "Web Server Url" is empty in the target and no override sets it`,
      'Override for "kapps/old/kapp" matches nothing in the export (check the key against the export/ file paths)',
    ],
  }));
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/plan/pl1' });
  const attention = await screen.findByRole('region', { name: 'Needs attention' });
  expect(attention).not.toHaveTextContent('Leave request was changed');
  expect(within(screen.getByRole('region', { name: 'Items' })).getByText('Kept')).toBeInTheDocument();
  const boxes = within(attention).getAllByRole('checkbox');
  expect(boxes).toHaveLength(2);
  expect(attention).toHaveTextContent('Web Server Url of hr is empty in Test and nothing sets it.');
  await user.click(within(attention).getByRole('checkbox', { name: /matches nothing being promoted/ }));
  expect(next()).toBeDisabled();
  await user.click(within(attention).getByRole('checkbox', { name: /Web Server Url of hr/ }));
  expect(next()).toBeEnabled();
  await user.click(within(attention).getByRole('checkbox', { name: /Web Server Url of hr/ }));
  expect(next()).toBeDisabled();
  // Once the value is filled in, the entry is done by itself.
  await user.click(within(attention).getByRole('checkbox', { name: /Web Server Url of hr/ }));
  await user.click(next());
  await user.type(screen.getByLabelText('Web Server Url in Test'), '[["https://test.example.com"]');
  await user.click(screen.getByRole('button', { name: 'Back' }));
  const filled = within(screen.getByRole('region', { name: 'Needs attention' })).getByRole('checkbox', { name: /Web Server Url of hr/ });
  expect(filled).toBeChecked();
  expect(filled).toBeDisabled();
  expect(next()).toBeEnabled();
});

test('values: numbers are checked; an optional value cleared says the target keeps its own', async () => {
  setup(simple({
    environmentValues: [
      { id: `${HANDLER}#properties.Timeout`, key: HANDLER, path: 'properties.Timeout', label: 'Timeout', from: 30, to: 60, origin: 'setting', required: false },
      { id: `${KAPP}#attributes.Web Server Url`, key: KAPP, path: 'attributes.Web Server Url', label: 'Web Server Url', from: ['https://dev.example.com'], to: ['https://test.example.com'], origin: 'attribute', required: false },
    ],
  }));
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/plan/pl1' });
  await screen.findByRole('heading', { name: '3 items from Dev' });
  await user.click(next());
  const timeout = screen.getByLabelText('Timeout in Test');
  await user.clear(timeout);
  await user.type(timeout, 'soon');
  expect(screen.getByText('Enter a number.')).toBeInTheDocument();
  expect(next()).toBeDisabled();
  await user.clear(timeout);
  expect(screen.getByText('Left blank, so Test keeps its own value (60).')).toBeInTheDocument();
  expect(next()).toBeEnabled();
  // A list value is edited as JSON.
  expect(screen.getByLabelText('Web Server Url in Test').tagName).toBe('TEXTAREA');
});

test('values: a kept space setting is not copied unless the offered value is taken, and a pair is taken whole', async () => {
  const pairRow = (label: string, from: unknown, to: unknown) => ({
    id: `space#${label}`, key: 'space', path: label, label, from, to, origin: 'environment' as const, required: false, suggested: from, pair: 'displayType+displayValue',
  });
  const m = setup(simple({
    items: [{ key: 'space', type: 'space', label: 'Space', action: 'update', drift: false, diff: [{ path: 'defaultLocale', from: 'en', to: 'fr' }] }],
    counts: { create: 0, update: 1, unchanged: 0, manual: 0, 'skip-drift': 0, delete: 0 },
    environmentValues: [
      pairRow('displayType', 'Custom', 'Display Page'),
      pairRow('displayValue', 'https://dev.example.com/app', null),
      { id: 'space#loginPage', key: 'space', path: 'loginPage', label: 'loginPage', from: '/dev-login', to: null, origin: 'environment', required: false, suggested: '/dev-login' },
    ],
    warnings: ['space: "displayValue" is kept per environment and empty in the target; the source has a value, which is not copied (set an override to use it)'],
  }));
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/plan/pl1' });
  await screen.findByRole('heading', { name: '3 items from Dev' });
  // Shown under Environment values, so nothing to tick here.
  expect(screen.queryByRole('region', { name: 'Needs attention' })?.querySelectorAll('input[type=checkbox]').length ?? 0).toBe(0);
  await user.click(next());
  const values = screen.getByRole('region', { name: 'Environment values' });
  expect(within(values).getByLabelText('displayValue in Test')).toHaveValue('');
  expect(within(values).getByText("Promoting does not copy Dev's value: Test stays empty unless you use it.", { selector: `[id$="-1-note"]` })).toBeInTheDocument();
  expect(within(values).getAllByText("Promoting does not copy Dev's value: Test keeps its own value unless you use it.")).toHaveLength(1);

  // Taking the display pair fills both halves; loginPage is left alone.
  await user.click(within(values).getAllByRole('button', { name: "Use Dev's values (displayType and displayValue)" })[0]);
  expect(within(values).getByLabelText('displayType in Test')).toHaveValue('Custom');
  expect(within(values).getByLabelText('displayValue in Test')).toHaveValue('https://dev.example.com/app');
  expect(within(values).getByLabelText('loginPage in Test')).toHaveValue('');
  expect(within(values).getAllByText("Saved as Test's value when the apply starts.")).toHaveLength(2);
  // Taken, then cleared: stays empty, and says so.
  await user.click(within(values).getByRole('button', { name: "Use Dev's value" }));
  await user.clear(within(values).getByLabelText('loginPage in Test'));
  expect(within(values).getByText('Left blank, so Test stays empty.')).toBeInTheDocument();

  await user.click(next());
  await user.type(screen.getByLabelText(/Type test to confirm/), 'test');
  await user.click(screen.getByRole('button', { name: 'Apply to Test' }));
  await waitFor(() => expect(m.callsTo('POST', '/api/projects/acme-demo/plans/pl1/apply')).toHaveLength(1));
  expect((m.callsTo('POST', '/api/projects/acme-demo/plans/pl1/apply')[0].body as { values: unknown }).values).toEqual({
    space: { displayType: 'Custom', displayValue: 'https://dev.example.com/app' },
  });
});
