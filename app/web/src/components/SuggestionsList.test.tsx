// Suggestions the comparison could not check are named, never added.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, test, vi } from 'vitest';
import type { SuggestionOut } from '../../../shared/sync-api';
import { SuggestionsList } from './SuggestionsList';

const base = { forKey: 'kapps/services/forms/it-request/form', kind: 'calls' };
const list: SuggestionOut[] = [
  { ...base, key: 'teams/Ops', label: 'Ops', status: 'new', reason: 'needs Ops, which is new in Dev' },
  { ...base, key: 'connections/Ticketing/connection', label: 'Ticketing', status: 'manual', unchecked: true, reason: "calls connection \"Ticketing\"; it couldn't be checked" },
];

test('an unchecked suggestion shows its reason and no Add; Add all is offered only for two or more addable ones', async () => {
  const onAdd = vi.fn();
  render(<MemoryRouter><SuggestionsList suggestions={list} onAdd={onAdd} onAddAll={() => {}} /></MemoryRouter>);
  expect(screen.getByText(/it couldn't be checked/)).toBeInTheDocument();
  expect(screen.getByText('Not checked')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add Ticketing' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add all' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Add Ops' }));
  expect(onAdd).toHaveBeenCalledWith(list[0]);
});
