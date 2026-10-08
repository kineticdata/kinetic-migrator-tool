// The first-run wizard: Next is gated on a successful connection test.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { AppRoutes } from '../routes';
import { mockApi, sse } from '../test/mock-api';
import { currentLocation, renderWithApp } from '../test/render';
import { env, project } from '../test/fixtures';

afterEach(() => vi.unstubAllGlobals());

function apiWith(testOk: boolean[]) {
  const detail = project({ environments: [env('dev', { lastSnapshot: null, credentials: { username: false, password: false } })] });
  let n = 0;
  return mockApi({
    'POST /api/projects': { status: 201, json: detail },
    'PUT /api/projects/:p/environments/:env': detail,
    'PUT /api/projects/:p/environments/:env/credentials': { username: true, password: true },
    'POST /api/projects/:p/environments/:env/test': () => {
      const ok = testOk[Math.min(n++, testOk.length - 1)];
      return ok
        ? { ok: true, steps: [{ step: 'core', label: 'Core sign-in', ok: true }, { step: 'integrator', label: 'Integrator token', ok: true }] }
        : { ok: false, steps: [{ step: 'core', label: 'Core sign-in', ok: false, message: 'The username or password was not accepted.' }, { step: 'integrator', label: 'Integrator token', ok: false, skipped: true }] };
    },
    'GET /api/projects/:p': detail,
    'POST /api/projects/:p/snapshots': { status: 202, json: { jobId: 'snap1' } },
    'GET /api/jobs/:id/events': { sse: sse([{ type: 'progress', data: { type: 'progress', phase: 'export', done: 3, total: 3 } }]) },
    'GET /api/jobs/:id': { id: 'snap1', kind: 'snapshot', status: 'succeeded', createdAt: 'x', result: { env: 'dev', commit: 'c1', total: 3, counts: {}, drifted: [] } },
    'GET /api/projects/:p/history': [],
    'GET /api/projects': [],
    'PUT /api/projects/:p/repository': (c: { body: unknown }) => ({ author: (c.body as { author: unknown }).author, remote: { url: null, token: { has: false } }, lastPush: null }),
  });
}

async function fillEnvironment(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Project name'), 'Demo migration');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.clear(screen.getByLabelText('Environment name'));
  await user.type(screen.getByLabelText('Environment name'), 'dev');
  await user.type(screen.getByLabelText('Space URL'), 'https://dev.your-space.kinops.io');
  await user.type(screen.getByLabelText('Username'), 'admin');
  await user.type(screen.getByLabelText('Password'), 'pw');
}

test('Next stays disabled until a connection test succeeds', async () => {
  const m = apiWith([false, true]);
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/new' });
  await fillEnvironment(user);

  const next = screen.getByRole('button', { name: 'Next' });
  expect(next).toBeDisabled();
  expect(next).toHaveAccessibleDescription('Test the connection to continue.');

  await user.click(screen.getByRole('button', { name: 'Test connection' }));
  expect(await screen.findByText('The username or password was not accepted.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  // The project now exists and is kept even if setup stops here.
  expect(screen.getByText(/Your project was saved/)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Test connection' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());

  // The project was created once, the credentials sent and the password field cleared.
  expect(m.callsTo('POST', '/api/projects')).toHaveLength(1);
  expect(m.callsTo('POST', '/api/projects')[0].body).toEqual({ name: 'Demo migration', environment: { name: 'dev', url: 'https://dev.your-space.kinops.io', readOnly: false } });
  expect(m.callsTo('PUT', '/api/projects/acme-demo/environments/dev/credentials')[0].body).toEqual({ username: 'admin', password: 'pw' });
  expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
});

test('editing the environment after a successful test gates Next again', async () => {
  apiWith([true]);
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/new' });
  await fillEnvironment(user);
  await user.click(screen.getByRole('button', { name: 'Test connection' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  await user.type(screen.getByLabelText('Space URL'), '/x');
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
});

test('the snapshot step shows progress and then opens the overview', async () => {
  const m = apiWith([true]);
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/new' });
  await fillEnvironment(user);
  await user.click(screen.getByRole('button', { name: 'Test connection' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Take snapshot' }));
  expect(m.callsTo('POST', '/api/projects/acme-demo/snapshots')[0].body).toEqual({ env: 'dev' });
  await user.click(await screen.findByRole('button', { name: 'Open overview' }));
  await waitFor(() => expect(currentLocation()).toBe('/p/acme-demo/overview'));
});

test('the last step can record the user’s name for History', async () => {
  const m = apiWith([true]);
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/new' });
  await fillEnvironment(user);
  await user.click(screen.getByRole('button', { name: 'Test connection' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.type(screen.getByLabelText('Your name'), 'Pat Example');
  // A name needs an email.
  await user.click(screen.getByRole('button', { name: 'Skip for now' }));
  expect(await screen.findByText(/Enter a valid email address/)).toBeInTheDocument();
  expect(currentLocation()).toBe('/new');
  await user.type(screen.getByLabelText('Your email'), 'pat@example.com');
  await user.click(screen.getByRole('button', { name: 'Skip for now' }));
  await waitFor(() => expect(currentLocation()).toBe('/p/acme-demo/overview'));
  expect(m.callsTo('PUT', '/api/projects/acme-demo/repository')[0].body).toEqual({ author: { name: 'Pat Example', email: 'pat@example.com' } });
});

test('leaving the name empty saves nothing', async () => {
  const m = apiWith([true]);
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/new' });
  await fillEnvironment(user);
  await user.click(screen.getByRole('button', { name: 'Test connection' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Skip for now' }));
  await waitFor(() => expect(currentLocation()).toBe('/p/acme-demo/overview'));
  expect(m.callsTo('PUT', '/api/projects/acme-demo/repository')).toHaveLength(0);
});
