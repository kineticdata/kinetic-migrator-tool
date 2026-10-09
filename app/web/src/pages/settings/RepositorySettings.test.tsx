// Settings → Repository: author, connecting a remote with a write-only token,
// pushing and the last push status.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { RepositorySettings } from '../../../../shared/repository-api';
import { AppRoutes } from '../../routes';
import { mockApi, sse } from '../../test/mock-api';
import { renderWithApp } from '../../test/render';
import { project } from '../../test/fixtures';

afterEach(() => vi.unstubAllGlobals());

const TOKEN = 'typed-token-123456';

function setup(initial: Partial<RepositorySettings> = {}) {
  let settings: RepositorySettings = {
    mode: 'managed',
    author: { name: 'kinetic-migrate', email: 'kinetic-migrate@localhost' },
    remote: { url: null, token: { has: false } },
    lastPush: null,
    ...initial,
  };
  let pushes = 0;
  const m = mockApi({
    'GET /api/projects/:p': project(),
    'GET /api/projects/:p/history': [],
    'GET /api/projects/:p/repository': () => settings,
    'PUT /api/projects/:p/repository': (c: { body: any }) => {
      const b = c.body;
      settings = {
        ...settings,
        author: b.author ?? settings.author,
        remote: {
          url: b.remoteUrl === undefined ? settings.remote.url : b.remoteUrl,
          token: { has: b.remoteUrl === null || b.token === null ? false : b.token ? true : settings.remote.token.has },
        },
      };
      return settings;
    },
    'POST /api/projects/:p/repository/push': () => {
      pushes++;
      return { status: 202, json: { jobId: 'push1' } };
    },
    'GET /api/jobs/push1/events': { sse: sse([{ type: 'step', data: { type: 'step', step: 'push', status: 'done' } }]) },
    'GET /api/jobs/push1': () => {
      settings = { ...settings, lastPush: { at: '2026-10-08T11:59:00Z', ok: true, commit: 'c-head', message: null } };
      return { id: 'push1', kind: 'push', status: 'succeeded', createdAt: 'x', result: settings.lastPush };
    },
  });
  return { ...m, pushes: () => pushes };
}

test('saves the commit author', async () => {
  const m = setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/settings/repository' });
  const name = await screen.findByLabelText('Name');
  // The built-in author shows as not set.
  expect(name).toHaveValue('');
  expect(screen.getByText(/No name is set yet/)).toBeInTheDocument();
  await user.type(name, 'Pat Example');
  await user.type(screen.getByLabelText('Email'), 'pat@example.com');
  await user.click(screen.getByRole('button', { name: 'Save author' }));
  await waitFor(() => expect(m.callsTo('PUT', '/api/projects/acme-demo/repository')).toHaveLength(1));
  expect(m.callsTo('PUT', '/api/projects/acme-demo/repository')[0].body).toEqual({ author: { name: 'Pat Example', email: 'pat@example.com' } });
});

test('connects a remote with a write-only token, which is cleared and never shown', async () => {
  const m = setup();
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/settings/repository' });
  const card = (await screen.findByRole('heading', { name: 'Remote repository' })).closest('div.rounded-xl') as HTMLElement;
  expect(within(card).getByText('Not set')).toBeInTheDocument();
  expect(within(card).getByRole('button', { name: 'Push' })).toBeDisabled();
  await user.type(within(card).getByLabelText('Address'), 'https://git.example.com/team/project.git');
  const token = within(card).getByLabelText('Token');
  expect(token).toHaveAttribute('type', 'password');
  await user.type(token, TOKEN);
  await user.click(within(card).getByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(m.callsTo('PUT', '/api/projects/acme-demo/repository')).toHaveLength(1));
  expect(m.callsTo('PUT', '/api/projects/acme-demo/repository')[0].body).toEqual({ remoteUrl: 'https://git.example.com/team/project.git', token: TOKEN });
  await waitFor(() => expect(within(card).getByLabelText('Token')).toHaveValue(''));
  expect(await within(card).findByText('Set')).toBeInTheDocument();
  expect(document.body.innerHTML).not.toContain(TOKEN);
});

test('pushes and shows the last push status', async () => {
  const m = setup({ remote: { url: 'https://git.example.com/team/project.git', token: { has: true } }, lastPush: { at: '2026-10-07T09:00:00Z', ok: false, commit: null, message: 'The remote repository refused the token (403).' } });
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/settings/repository' });
  expect(await screen.findByText(/refused the token/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Push' }));
  expect(m.pushes()).toBe(1);
  expect(await screen.findByText(/Last push succeeded/)).toBeInTheDocument();
});

test('disconnects the remote', async () => {
  const m = setup({ remote: { url: 'https://git.example.com/team/project.git', token: { has: true } } });
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/settings/repository' });
  await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
  await waitFor(() => expect(m.callsTo('PUT', '/api/projects/acme-demo/repository')[0]?.body).toEqual({ remoteUrl: null }));
});
