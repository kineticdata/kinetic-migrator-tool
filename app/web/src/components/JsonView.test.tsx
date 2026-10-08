// JsonView: folding, a capped Expand all and paged long lists.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { EXPAND_ALL_DEPTH, JsonView, PAGE } from './JsonView';

test('Expand all stops at a depth; deeper levels stay folded', async () => {
  // The root counts as the first level.
  let deep: Record<string, unknown> = { leaf: 'bottom' };
  for (let i = 9; i >= 0; i--) deep = { [`level${i}`]: deep };
  render(<JsonView value={deep} />);
  await userEvent.click(screen.getByRole('button', { name: 'Expand all' }));
  const json = screen.getByRole('region', { name: 'JSON' });
  expect(within(json).getByRole('button', { name: new RegExp(`"level${EXPAND_ALL_DEPTH - 2}"`) })).toHaveAttribute('aria-expanded', 'true');
  expect(within(json).getByRole('button', { name: new RegExp(`"level${EXPAND_ALL_DEPTH - 1}"`) })).toHaveAttribute('aria-expanded', 'false');
  expect(json).not.toHaveTextContent('bottom');
});

test('long lists show the first entries and a "Show more"', async () => {
  const value = { rows: Array.from({ length: 250 }, (_, i) => `row-${i}`) };
  render(<JsonView value={value} />);
  await userEvent.click(screen.getByRole('button', { name: 'Expand all' }));
  const json = screen.getByRole('region', { name: 'JSON' });
  expect(json).toHaveTextContent(`row-${PAGE - 1}`);
  expect(json).not.toHaveTextContent(`row-${PAGE}"`);
  await userEvent.click(within(json).getByRole('button', { name: 'Show 100 more of 150' }));
  expect(json).toHaveTextContent('row-199');
  expect(within(json).getByRole('button', { name: 'Show 50 more of 50' })).toBeInTheDocument();
});
