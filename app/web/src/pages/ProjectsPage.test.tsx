// Projects launcher: list, new and open folder.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { AppRoutes } from '../routes';
import { mockApi } from '../test/mock-api';
import { currentLocation, renderWithApp } from '../test/render';
import { project } from '../test/fixtures';

afterEach(() => vi.unstubAllGlobals());

test('lists projects and opens one', async () => {
  mockApi({
    'GET /api/session': { version: '0.1.0', workspace: '/workspace', keychain: { available: true } },
    'GET /api/projects': [{ id: 'acme-demo', name: 'Demo migration', path: '/workspace/acme-demo' }],
    'GET /api/projects/:p': project(),
    'GET /api/projects/:p/history': [],
  });
  renderWithApp(<AppRoutes />, { route: '/' });
  await userEvent.click(await screen.findByRole('link', { name: /Demo migration/ }));
  await waitFor(() => expect(currentLocation()).toBe('/p/acme-demo/overview'));
});

test('an empty workspace invites creating the first project', async () => {
  mockApi({
    'GET /api/session': { version: '0.1.0', workspace: '/workspace', keychain: { available: false } },
    'GET /api/projects': [],
  });
  renderWithApp(<AppRoutes />, { route: '/' });
  await userEvent.click(await screen.findByRole('link', { name: 'Create your first project' }));
  expect(currentLocation()).toBe('/new');
});

test('open folder posts the path and navigates to the project', async () => {
  const m = mockApi({
    'GET /api/session': { version: '0.1.0', workspace: '/workspace', keychain: { available: true } },
    'GET /api/projects': [],
    'POST /api/projects/open': project({ id: 'opened' }),
    'GET /api/projects/:p': project({ id: 'opened' }),
    'GET /api/projects/:p/history': [],
  });
  const user = userEvent.setup();
  renderWithApp(<AppRoutes />, { route: '/' });
  await user.click(await screen.findByRole('button', { name: 'Open folder…' }));
  await user.type(screen.getByLabelText('Folder path'), '/elsewhere/project');
  await user.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(currentLocation()).toBe('/p/opened/overview'));
  expect(m.callsTo('POST', '/api/projects/open')[0].body).toEqual({ path: '/elsewhere/project' });
});

test('while the server is still checking the keychain, the page says so instead of "no keychain", then updates', async () => {
  let checking = true;
  mockApi({
    'GET /api/session': () => ({ version: '0.1.0', workspace: '/workspace', keychain: { available: !checking, ...(checking ? { checking: true } : {}) } }),
    'GET /api/projects': [],
  });
  renderWithApp(<AppRoutes />, { route: '/' });
  expect(await screen.findByText('Checking the system keychain…')).toBeInTheDocument();
  expect(screen.queryByText(/No system keychain was found/)).not.toBeInTheDocument();
  checking = false;
  await waitFor(() => expect(screen.queryByText('Checking the system keychain…')).not.toBeInTheDocument(), { timeout: 5000 });
  expect(screen.queryByText(/No system keychain was found/)).not.toBeInTheDocument();
});

test('shows the server log file', async () => {
  mockApi({
    'GET /api/session': { version: '0.1.0', workspace: '/workspace', keychain: { available: true }, logFile: '/workspace/.kinetic-migrate/logs/kinetic-migrate-2026-10-08.log' },
    'GET /api/projects': [{ id: 'acme-demo', name: 'Demo migration', path: '/workspace/acme-demo' }],
  });
  renderWithApp(<AppRoutes />, { route: '/' });
  expect(await screen.findByText('/workspace/.kinetic-migrate/logs/kinetic-migrate-2026-10-08.log')).toBeInTheDocument();
});
