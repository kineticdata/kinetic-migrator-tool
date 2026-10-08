// Smoke test: the full app (providers, router, routes) renders the launcher.
import { render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App';
import { mockApi } from './test/mock-api';

afterEach(() => vi.unstubAllGlobals());

test('renders the projects launcher', async () => {
  mockApi({
    'GET /api/session': { version: '0.1.0', workspace: '/workspace', keychain: { available: true } },
    'GET /api/projects': [],
  });
  render(<App />);
  expect(screen.getByRole('link', { name: /Kinetic Migrate/ })).toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
  expect(await screen.findByText('No projects yet')).toBeInTheDocument();
});
