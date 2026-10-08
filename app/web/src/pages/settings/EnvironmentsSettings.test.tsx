// Settings → Environments: pipeline order, credentials status and testing.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { AppRoutes } from '../../routes';
import { mockApi } from '../../test/mock-api';
import { renderWithApp } from '../../test/render';
import { env, project } from '../../test/fixtures';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  let detail = project();
  return mockApi({
    'GET /api/projects/:p': () => detail,
    'GET /api/projects/:p/history': [],
    'PUT /api/projects/:p/environments/:env': (c: { body: { position?: number } }, p: Record<string, string>) => {
      const envs = detail.environments.filter((e) => e.name !== p.env);
      const moved = detail.environments.find((e) => e.name === p.env) ?? env(p.env);
      envs.splice(c.body.position ?? envs.length, 0, moved);
      detail = { ...detail, environments: envs };
      return detail;
    },
    'POST /api/projects/:p/environments/:env/test': { ok: true, steps: [{ step: 'core', label: 'Core sign-in', ok: true }, { step: 'integrator', label: 'Integrator token', ok: true }] },
  });
}

const rows = () => screen.getAllByRole('listitem').map((li) => li.getAttribute('data-env'));

test('the pipeline order can be changed', async () => {
  const m = setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/settings/environments' });
  await screen.findByRole('button', { name: 'Move Test earlier' });
  expect(rows()).toEqual(['dev', 'test', 'prod']);

  await user.click(screen.getByRole('button', { name: 'Move Test earlier' }));
  const put = m.callsTo('PUT', '/api/projects/acme-demo/environments/test');
  expect(put[0].body).toEqual({ url: 'https://test.your-space.kinops.io', readOnly: false, position: 0 });
  await waitFor(() => expect(rows()).toEqual(['test', 'dev', 'prod']));

  expect(screen.getByRole('button', { name: 'Move Test earlier' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Move Prod later' })).toBeDisabled();
});

test('shows protected and credentials status, and tests a connection', async () => {
  const user = userEvent.setup();
  setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/settings/environments' });
  const prod = (await screen.findAllByRole('listitem')).find((li) => li.getAttribute('data-env') === 'prod')!;
  expect(within(prod).getByText('Protected')).toBeInTheDocument();
  expect(within(prod).getByText(/Password set/)).toBeInTheDocument();
  await user.click(within(prod).getByRole('button', { name: 'Test Prod' }));
  expect(await within(prod).findByText('Connected')).toBeInTheDocument();
});
