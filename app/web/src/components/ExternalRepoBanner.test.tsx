// The "in your repository" banner on Overview and History for a project
// inside the user's own repository, and nothing for a managed project.
import { screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { RepositorySettings } from '../../../shared/repository-api';
import { AppRoutes } from '../routes';
import { mockApi } from '../test/mock-api';
import { renderWithApp } from '../test/render';
import { historyEvent, project } from '../test/fixtures';
import { externalSummary } from './ExternalRepoBanner';

afterEach(() => vi.unstubAllGlobals());

const external = (over: Partial<NonNullable<RepositorySettings['external']>> = {}): RepositorySettings => ({
  mode: 'external',
  author: { name: 'kinetic-migrate', email: 'kinetic-migrate@localhost' },
  remote: { url: null, token: { has: false } },
  lastPush: null,
  external: {
    root: '/work/monorepo', name: 'monorepo', kind: 'repository', branch: 'feature/x', subfolder: 'apps/config/kinetic',
    changedFiles: 3, checking: false, operation: null, historyPath: '/data/history/abc', ...over,
  },
});

function setup(settings: RepositorySettings) {
  return mockApi({
    'GET /api/projects/:p': project(),
    'GET /api/projects/:p/history': [historyEvent({ id: 'h1', type: 'snapshot', title: 'Snapshot of Dev', env: 'dev' })],
    'GET /api/projects/:p/repository': settings,
  });
}

test('the summary names the repository, branch and changed files', () => {
  expect(externalSummary(external().external!)).toBe(
    "This project is in your repository monorepo on branch feature/x; Kinetic Migrator doesn't commit there — 3 files changed since your last commit.",
  );
  expect(externalSummary(external({ branch: null, changedFiles: 1 }).external!)).toMatch(/on a detached commit; .* 1 file changed/);
  expect(externalSummary(external({ changedFiles: null }).external!)).not.toMatch(/changed since/);
  expect(externalSummary(external({ changedFiles: null, checking: true }).external!)).toMatch(/checking for files changed since your last commit…\.$/);
});

test('History shows the banner, with a busy repository called out', async () => {
  setup(external({ operation: 'merge' }));
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/history' });
  const note = await screen.findByRole('note', { name: 'Your repository' });
  expect(note).toHaveTextContent('This project is in your repository monorepo on branch feature/x');
  expect(note).toHaveTextContent('3 files changed since your last commit');
  expect(note).toHaveTextContent('A merge is in progress there');
});

test('Overview shows the banner', async () => {
  setup(external());
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/overview' });
  expect(await screen.findByRole('note', { name: 'Your repository' })).toHaveTextContent("Kinetic Migrator doesn't commit there");
});

test('a managed project shows no banner', async () => {
  setup({ ...external(), mode: 'managed', external: undefined });
  renderWithApp(<AppRoutes />, { route: '/p/acme-demo/history' });
  expect(await screen.findByRole('heading', { name: 'History' })).toBeInTheDocument();
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByRole('note', { name: 'Your repository' })).toBeNull();
});
