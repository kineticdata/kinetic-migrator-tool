// FieldDiffTable: values in words, the raw path as secondary text and the
// full value one click away.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { DiffNamesProvider, FieldDiffTable } from './FieldDiffTable';

const diff = [
  { path: 'pages[Page 1].elements[Asset Tag]', from: undefined, to: { dataType: 'string', label: 'Asset Tag', name: 'Asset Tag', renderType: 'text', required: false, type: 'field' } },
  { path: 'integrations', from: undefined, to: [{ name: 'Create Ticket', connectionId: 'c-1', operationId: 'o-1' }] },
];

test('objects read as summaries, with the full value on demand', async () => {
  render(
    <DiffNamesProvider value={{ target: {}, incoming: { 'c-1': 'Ticketing', 'o-1': 'Create Ticket' } }}>
      <FieldDiffTable diff={diff} from="Dev" to="test" />
    </DiffNamesProvider>,
  );
  const rows = screen.getAllByRole('row').slice(1);
  expect(within(rows[0]).getByText('Page “Page 1” › Element “Asset Tag”')).toBeInTheDocument();
  expect(within(rows[0]).getByText('pages[Page 1].elements[Asset Tag]')).toBeInTheDocument();
  expect(within(rows[0]).getByText('Text field')).toBeInTheDocument();
  expect(within(rows[0]).queryByText(/"dataType"/)).toBeNull();
  expect(within(rows[1]).getByText('Calls Create Ticket on Ticketing')).toBeInTheDocument();

  await userEvent.click(within(rows[0]).getByRole('button', { name: 'Show full value' }));
  expect(within(rows[0]).getByText(/"dataType": "string"/)).toBeInTheDocument();
  await userEvent.click(within(rows[0]).getByRole('button', { name: 'Show summary' }));
  expect(within(rows[0]).queryByText(/"dataType"/)).toBeNull();
});
