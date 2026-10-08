// The pipeline strip: one pill per environment in order, with lock, snapshot
// age and drift; clicking a pill sets the active environment in the URL.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { PipelineStrip } from './PipelineStrip';
import { currentLocation, renderWithApp } from '../test/render';
import { env, NOW } from '../test/fixtures';

const envs = [env('dev'), env('test', { lastSnapshot: null }), env('prod', { readOnly: true })];

test('renders pills with lock, snapshot age and drift', () => {
  renderWithApp(<PipelineStrip projectId="acme-demo" environments={envs} drift={{ prod: 2 }} active="dev" now={NOW} />, { route: '/p/acme-demo/overview' });
  const pills = screen.getAllByRole('link');
  expect(pills.map((p) => p.getAttribute('data-env'))).toEqual(['dev', 'test', 'prod']);
  expect(within(pills[0]).getByText('2h ago')).toBeInTheDocument();
  expect(pills[0]).toHaveAttribute('aria-current', 'true');
  expect(within(pills[1]).getByText('No snapshot')).toBeInTheDocument();
  expect(within(pills[2]).getByLabelText('Protected')).toBeInTheDocument();
  expect(within(pills[2]).getByText('2 drifted')).toBeInTheDocument();
});

test('clicking a pill stores the active environment in the URL', async () => {
  renderWithApp(<PipelineStrip projectId="acme-demo" environments={envs} drift={{}} active="dev" now={NOW} />, { route: '/p/acme-demo/overview' });
  await userEvent.click(screen.getByRole('link', { name: /Test/ }));
  expect(currentLocation()).toBe('/p/acme-demo/overview?env=test');
});

test('on Explore, a pill switches the explored environment', async () => {
  renderWithApp(<PipelineStrip projectId="acme-demo" environments={envs} drift={{}} active="dev" now={NOW} />, { route: '/p/acme-demo/explore/dev/kapps' });
  await userEvent.click(screen.getByRole('link', { name: /Prod/ }));
  expect(currentLocation()).toBe('/p/acme-demo/explore/prod');
});
