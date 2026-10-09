// Credentials typed in the environment dialog are sent once and then
// forgotten: never kept in the field, a mutation's variables or query data.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { EnvironmentDialog } from './EnvironmentDialog';
import { mockApi } from '../../test/mock-api';
import { renderWithApp } from '../../test/render';
import { env, project } from '../../test/fixtures';

afterEach(() => vi.unstubAllGlobals());

const SECRET = 'planted-Pa55word';

test('saving sends the password once and leaves no copy in the query client', async () => {
  const m = mockApi({
    'PUT /api/projects/:p/environments/:env': project({ environments: [env('dev'), env('qa')] }),
    'PUT /api/projects/:p/environments/:env/credentials': { username: true, password: true },
    'POST /api/projects/:p/environments/:env/test': { ok: true, steps: [{ step: 'core', label: 'Core sign-in', ok: true }] },
  });
  const user = userEvent.setup();
  const { client } = renderWithApp(<EnvironmentDialog projectId="acme-demo" environment={null} onClose={() => {}} />);
  await user.type(screen.getByLabelText('Environment name'), 'qa');
  await user.type(screen.getByLabelText('Space URL'), 'https://qa.your-space.kinops.io');
  await user.type(screen.getByLabelText('Username'), 'admin');
  await user.type(screen.getByLabelText('Password'), SECRET);
  await user.click(screen.getByRole('button', { name: 'Test connection' }));

  await screen.findByText('Connected');
  expect(m.callsTo('PUT', '/api/projects/acme-demo/environments/qa/credentials')[0].body).toEqual({ username: 'admin', password: SECRET });
  await waitFor(() => expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe(''));

  const mutations = JSON.stringify(client.getMutationCache().getAll().map((mu) => mu.state));
  const queries = JSON.stringify(client.getQueryCache().getAll().map((q) => q.state));
  expect(mutations).not.toContain(SECRET);
  expect(queries).not.toContain(SECRET);
});

test('an http:// address to another machine is refused before anything is sent; localhost is accepted', async () => {
  const m = mockApi({
    'PUT /api/projects/:p/environments/:env': project({ environments: [env('dev'), env('qa')] }),
    'PUT /api/projects/:p/environments/:env/credentials': { username: true, password: true },
    'POST /api/projects/:p/environments/:env/test': { ok: true, steps: [{ step: 'core', label: 'Core sign-in', ok: true }] },
  });
  const user = userEvent.setup();
  renderWithApp(<EnvironmentDialog projectId="acme-demo" environment={null} onClose={() => {}} />);
  await user.type(screen.getByLabelText('Environment name'), 'qa');
  await user.type(screen.getByLabelText('Space URL'), 'http://qa.your-space.kinops.io');
  await user.type(screen.getByLabelText('Username'), 'admin');
  await user.type(screen.getByLabelText('Password'), SECRET);
  await user.click(screen.getByRole('button', { name: 'Test connection' }));
  expect(await screen.findByText(/^Start the address with https:\/\/\. Plain http:\/\/ is only accepted for this computer/)).toBeInTheDocument();
  expect(m.callsTo('PUT', '/api/projects/acme-demo/environments/qa')).toHaveLength(0);
  expect(m.callsTo('PUT', '/api/projects/acme-demo/environments/qa/credentials')).toHaveLength(0);

  await user.clear(screen.getByLabelText('Space URL'));
  await user.type(screen.getByLabelText('Space URL'), 'http://localhost:8080');
  await user.click(screen.getByRole('button', { name: 'Test connection' }));
  await screen.findByText('Connected');
  expect(m.callsTo('PUT', '/api/projects/acme-demo/environments/qa')[0].body).toMatchObject({ url: 'http://localhost:8080' });
});
