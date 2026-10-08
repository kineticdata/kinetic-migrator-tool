// SecretInput is write-only: it never renders a stored value and only says
// whether one is set.
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import { SecretInput } from './SecretInput';

function Harness({ isSet }: { isSet: boolean }) {
  const [value, setValue] = useState('');
  return <SecretInput label="Password" isSet={isSet} value={value} onChange={setValue} />;
}

test('shows "Set" and an empty field when a value is stored', () => {
  render(<Harness isSet />);
  const input = screen.getByLabelText('Password') as HTMLInputElement;
  expect(input.value).toBe('');
  expect(input).toHaveAttribute('type', 'password');
  expect(screen.getByText('Set')).toBeInTheDocument();
  expect(input).toHaveAttribute('placeholder', expect.stringMatching(/replace/i));
});

test('shows "Not set" when nothing is stored', () => {
  render(<Harness isSet={false} />);
  expect(screen.getByText('Not set')).toBeInTheDocument();
});

test('typed text is masked and never shown as text, with no reveal control', async () => {
  const { container } = render(<Harness isSet={false} />);
  const input = screen.getByLabelText('Password');
  await userEvent.type(input, 's3cr3t-value');
  expect(input).toHaveAttribute('type', 'password');
  expect(container.textContent).not.toContain('s3cr3t-value');
  expect(screen.queryByRole('button', { name: /show|reveal/i })).toBeNull();
  expect(input).toHaveAttribute('autocomplete', 'new-password');
});
