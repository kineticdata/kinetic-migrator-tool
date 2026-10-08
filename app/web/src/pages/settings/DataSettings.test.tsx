// Settings → Data & values: environment-specific attribute rules and
// reference-data entries, picked from the catalog (latest snapshot) or typed.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { ProjectCatalog, ProjectConfig } from '../../../../shared/api';
import { AppRoutes } from '../../routes';
import { mockApi } from '../../test/mock-api';
import { renderWithApp } from '../../test/render';
import { project } from '../../test/fixtures';

afterEach(() => vi.unstubAllGlobals());

const CATALOG: ProjectCatalog = {
  env: 'dev',
  kapps: [{
    slug: 'services', name: 'Services',
    forms: [
      { slug: 'it-request', name: 'IT Request', fields: ['Priority', 'Summary'] },
      { slug: 'lookups', name: 'Lookups', fields: ['Code', 'Label', 'Type'] },
    ],
    categories: [{ slug: 'hardware', name: 'Hardware' }],
    attributes: { kapp: ['Url'], form: ['Queue'], category: ['Icon'] },
  }],
  teams: ['Ops'],
  attributes: { space: ['Host'], kapp: ['Url'], form: ['Queue'], team: ['Email'], category: ['Icon'] },
};

const NO_SNAPSHOT: ProjectCatalog = { env: null, kapps: [], teams: [], attributes: { space: [], kapp: [], form: [], team: [], category: [] } };

function setup(initial: Partial<ProjectConfig> = {}, catalog: ProjectCatalog = CATALOG) {
  let config: ProjectConfig = { data: [], exclude: { kapps: [], forms: [] }, envBoundAttributes: {}, ...initial };
  return mockApi({
    'GET /api/projects/:p': project(),
    'GET /api/projects/:p/history': [],
    'GET /api/projects/:p/catalog': catalog,
    'GET /api/projects/:p/config': () => config,
    'PUT /api/projects/:p/config': (c: { body: Partial<ProjectConfig> }) => {
      config = { ...config, ...c.body };
      return config;
    },
  });
}

const open = () => renderWithApp(<AppRoutes />, { route: '/p/acme-demo/settings/data' });
const card = async (title: string) => (await screen.findByRole('heading', { name: title })).closest('div.rounded-xl') as HTMLElement;
const lastPut = (m: ReturnType<typeof setup>) => m.callsTo('PUT', '/api/projects/acme-demo/config').at(-1)!.body as Partial<ProjectConfig>;

test('shows legacy names as "any" rules and scoped rules with their target, and saves them unchanged', async () => {
  const m = setup({ envBoundAttributes: { kapp: ['Logo'], form: [{ name: 'Queue', kapp: 'services', form: 'it-request' }], team: ['Email'] } });
  const user = userEvent.setup();
  open();
  const rules = await card('Environment-specific attributes');
  expect(await within(rules).findByLabelText('Level for rule 1')).toHaveValue('kapp');
  expect(within(rules).getByLabelText('Kapp for rule 1')).toHaveDisplayValue('Any kapp');
  expect(within(rules).getByLabelText('Attribute for rule 1')).toHaveValue('Logo');
  expect(within(rules).getByLabelText('Kapp for rule 2')).toHaveDisplayValue('Services');
  expect(within(rules).getByLabelText('Form for rule 2')).toHaveDisplayValue('IT Request');
  expect(within(rules).getByLabelText('Team for rule 3')).toHaveDisplayValue('Any team');
  expect(within(rules).getByText('Lists come from the latest snapshot of Dev.')).toBeInTheDocument();

  await user.click(within(rules).getByRole('button', { name: 'Save attributes' }));
  await waitFor(() => expect(m.callsTo('PUT', '/api/projects/acme-demo/config')).toHaveLength(1));
  expect(lastPut(m)).toEqual({
    envBoundAttributes: { space: [], kapp: ['Logo'], form: [{ name: 'Queue', kapp: 'services', form: 'it-request' }], team: ['Email'], category: [] },
  });
});

test('adds a scoped rule from the lists, removes another, and refuses a rule without an attribute', async () => {
  const m = setup({ envBoundAttributes: { space: ['Host'] } });
  const user = userEvent.setup();
  open();
  const rules = await card('Environment-specific attributes');
  await within(rules).findByLabelText('Level for rule 1');
  await user.click(within(rules).getByRole('button', { name: 'Add rule' }));
  await user.selectOptions(within(rules).getByLabelText('Level for rule 2'), 'category');
  await user.selectOptions(within(rules).getByLabelText('Kapp for rule 2'), 'services');
  await user.selectOptions(within(rules).getByLabelText('Category for rule 2'), 'hardware');
  await user.click(within(rules).getByRole('button', { name: 'Save attributes' }));
  expect(await within(rules).findByText('Each rule needs an attribute name.')).toBeInTheDocument();
  expect(m.callsTo('PUT', '/api/projects/acme-demo/config')).toHaveLength(0);

  // The attribute box suggests names for that level.
  const attr = within(rules).getByLabelText('Attribute for rule 2');
  const list = document.getElementById(attr.getAttribute('list')!)!;
  expect([...list.querySelectorAll('option')].map((o) => o.getAttribute('value'))).toEqual(['Icon']);
  await user.type(attr, 'Icon');
  await user.click(within(rules).getByRole('button', { name: 'Remove rule 1' }));
  await user.click(within(rules).getByRole('button', { name: 'Save attributes' }));
  await waitFor(() => expect(m.callsTo('PUT', '/api/projects/acme-demo/config')).toHaveLength(1));
  expect(lastPut(m)).toEqual({
    envBoundAttributes: { space: [], kapp: [], form: [], team: [], category: [{ name: 'Icon', kapp: 'services', category: 'hardware' }] },
  });
});

test('without a snapshot the pickers are text boxes and say how to get lists', async () => {
  const m = setup({ data: [{ kapp: 'services', form: 'lookups', key: ['Code'] }] }, NO_SNAPSHOT);
  const user = userEvent.setup();
  open();
  const rules = await card('Environment-specific attributes');
  await user.click(within(rules).getByRole('button', { name: 'Add rule' }));
  await user.selectOptions(within(rules).getByLabelText('Level for rule 1'), 'team');
  const team = within(rules).getByLabelText('Team for rule 1');
  expect(team.tagName).toBe('INPUT');
  expect(team).toHaveAttribute('placeholder', 'Any team');
  await user.type(team, 'Ops');
  await user.type(within(rules).getByLabelText('Attribute for rule 1'), 'Email');
  expect(within(rules).getByText('Take a snapshot to pick from lists.')).toBeInTheDocument();
  await user.click(within(rules).getByRole('button', { name: 'Save attributes' }));
  await waitFor(() => expect(m.callsTo('PUT', '/api/projects/acme-demo/config')).toHaveLength(1));
  expect(lastPut(m).envBoundAttributes?.team).toEqual([{ name: 'Email', team: 'Ops' }]);

  const data = await card('Reference data');
  expect(within(data).getByLabelText('Kapp for entry 1').tagName).toBe('INPUT');
  expect(within(data).getByLabelText('Match fields for entry 1')).toHaveValue('Code');
  expect(within(data).getByText('Take a snapshot to pick from lists.')).toBeInTheDocument();
});

test('reference data: shows an existing keyed entry and adds a filtered entry with match fields', async () => {
  const m = setup({ data: [{ kapp: 'services', form: 'lookups', key: ['Code'] }] });
  const user = userEvent.setup();
  open();
  const data = await card('Reference data');
  expect(await within(data).findByLabelText('Kapp for entry 1')).toHaveDisplayValue('Services');
  expect(within(data).getByLabelText('Form for entry 1')).toHaveDisplayValue('Lookups');
  expect(within(data).getByText('All records')).toBeInTheDocument();
  const match1 = within(data).getByRole('group', { name: 'Match fields for entry 1' });
  expect(within(match1).getByRole('checkbox', { name: 'Code' })).toBeChecked();
  expect(within(match1).getByRole('checkbox', { name: 'Label' })).not.toBeChecked();
  expect(within(data).getAllByText(/Fields used to find the same record in the other environment/)).toHaveLength(1);

  await user.click(within(data).getByRole('button', { name: 'Add entry' }));
  await user.selectOptions(within(data).getByLabelText('Kapp for entry 2'), 'services');
  await user.selectOptions(within(data).getByLabelText('Form for entry 2'), 'lookups');
  const entry2 = data.querySelector('[data-entry="2"]') as HTMLElement;
  await user.click(within(entry2).getByRole('button', { name: 'Add condition' }));
  await user.type(within(entry2).getByLabelText('Field for condition 1 of entry 2'), 'Type');
  // A condition needs a value.
  await user.click(within(data).getByRole('button', { name: 'Save reference data' }));
  expect(await within(data).findByText('Each entry needs a kapp and a form, and each condition a field and a value.')).toBeInTheDocument();
  expect(m.callsTo('PUT', '/api/projects/acme-demo/config')).toHaveLength(0);

  await user.type(within(entry2).getByLabelText('Value for condition 1 of entry 2'), 'Lookup');
  await user.click(within(within(entry2).getByRole('group', { name: 'Match fields for entry 2' })).getByRole('checkbox', { name: 'Label' }));
  // Entry 1 loses its match fields: it becomes keyless.
  await user.click(within(match1).getByRole('checkbox', { name: 'Code' }));
  await user.click(within(data).getByRole('button', { name: 'Save reference data' }));
  await waitFor(() => expect(m.callsTo('PUT', '/api/projects/acme-demo/config')).toHaveLength(1));
  expect(lastPut(m)).toEqual({
    data: [
      { kapp: 'services', form: 'lookups' },
      { kapp: 'services', form: 'lookups', filter: [{ field: 'Type', value: 'Lookup' }], key: ['Label'] },
    ],
  });
});

test('reference data: a kapp and a form are required', async () => {
  const m = setup();
  const user = userEvent.setup();
  open();
  const data = await card('Reference data');
  expect(within(data).getByText('No reference data is copied. Only configuration is promoted.')).toBeInTheDocument();
  await user.click(within(data).getByRole('button', { name: 'Add entry' }));
  await user.selectOptions(within(data).getByLabelText('Kapp for entry 1'), 'services');
  await user.click(within(data).getByRole('button', { name: 'Save reference data' }));
  expect(await within(data).findByText(/Each entry needs a kapp and a form/)).toBeInTheDocument();
  expect(m.callsTo('PUT', '/api/projects/acme-demo/config')).toHaveLength(0);
});

test('shows parts of the project file that are ignored, and marks the rule missing a name', async () => {
  setup({ envBoundAttributes: { kapp: ['Logo'] }, warnings: ['kinetic-sync.config.json: "envBoundAttributes": unknown level "forms" (use space, kapp, form, team, category); it is ignored.'] });
  const user = userEvent.setup();
  open();
  const rules = await card('Environment-specific attributes');
  expect(await within(rules).findByText(/unknown level "forms"/)).toBeInTheDocument();
  await user.click(within(rules).getByRole('button', { name: 'Add rule' }));
  await user.selectOptions(within(rules).getByLabelText('Kapp for rule 2'), 'services');
  await user.click(within(rules).getByRole('button', { name: 'Save attributes' }));
  const attr = within(rules).getByLabelText('Attribute for rule 2');
  expect(attr).toHaveAttribute('aria-invalid', 'true');
  expect(document.getElementById(attr.getAttribute('aria-describedby')!)).toHaveTextContent('Each rule needs an attribute name.');
  expect(within(rules).getByLabelText('Attribute for rule 1')).not.toHaveAttribute('aria-invalid');
});

test('saving one card keeps unsaved edits in the other, and picking another form drops its old conditions and match fields', async () => {
  const m = setup({ data: [{ kapp: 'services', form: 'lookups', key: ['Code'], filter: [{ field: 'Type', value: 'Lookup' }] }] });
  const user = userEvent.setup();
  open();
  const rules = await card('Environment-specific attributes');
  const data = await card('Reference data');
  await user.click(within(rules).getByRole('button', { name: 'Add rule' }));
  await user.type(within(rules).getByLabelText('Attribute for rule 1'), 'Url');
  await user.click(within(data).getByRole('button', { name: 'Add entry' }));
  await user.click(within(rules).getByRole('button', { name: 'Save attributes' }));
  await waitFor(() => expect(m.callsTo('PUT', '/api/projects/acme-demo/config')).toHaveLength(1));
  // The unsaved new entry survives the other card's save.
  expect(within(data).getByLabelText('Kapp for entry 2')).toBeInTheDocument();

  await user.selectOptions(within(data).getByLabelText('Form for entry 1'), 'it-request');
  expect(within(data).getAllByText('All records').length).toBeGreaterThan(0);
  const match1 = within(data).getByRole('group', { name: 'Match fields for entry 1' });
  expect(within(match1).queryByRole('checkbox', { name: 'Code' })).toBeNull();
  expect(within(match1).getByRole('checkbox', { name: 'Priority' })).not.toBeChecked();
});

const DEFAULT_KEPT = ['displayType', 'displayValue', 'trustedFrameDomains', 'trustedResourceDomains', 'allowedIps', 'allowedIpsEnabled'];
const DEFAULT_BOXES = ['displayType + displayValue', 'trustedFrameDomains', 'trustedResourceDomains', 'allowedIps + allowedIpsEnabled'];

test('space settings: one box per setting or linked pair, the always-kept fields fixed, and ticked extras saved', async () => {
  const m = setup({ envBoundSpaceFields: DEFAULT_KEPT });
  const user = userEvent.setup();
  open();
  const space = await card('Space settings kept per environment');
  for (const f of DEFAULT_BOXES) expect(within(space).getByRole('checkbox', { name: f })).toBeChecked();
  expect(within(space).getByRole('checkbox', { name: 'trustedFrameDomains' })).toHaveAccessibleDescription('Sites allowed to show the space inside a frame');
  expect(within(space).getByRole('checkbox', { name: 'loginPage' })).not.toBeChecked();
  for (const f of ['name', 'slug', 'platformComponents', 'bundlePath', 'sharedBundleBase']) {
    const box = within(space).getByRole('checkbox', { name: f });
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
  }
  await user.click(within(space).getByRole('checkbox', { name: 'defaultLocale' }));
  // A pair is unticked (and saved) as a whole.
  await user.click(within(space).getByRole('checkbox', { name: 'allowedIps + allowedIpsEnabled' }));
  await user.click(within(space).getByRole('checkbox', { name: 'loginPage' }));
  await user.click(within(space).getByRole('button', { name: 'Save space settings' }));
  await waitFor(() => expect(m.callsTo('PUT', '/api/projects/acme-demo/config')).toHaveLength(1));
  expect(lastPut(m)).toEqual({
    envBoundSpaceFields: ['displayType', 'displayValue', 'trustedFrameDomains', 'trustedResourceDomains', 'loginPage', 'defaultLocale'],
  });
});

test('space settings: a half pair from the server shows the pair unticked; ticking it saves both halves', async () => {
  const m = setup({ envBoundSpaceFields: ['displayValue'] });
  const user = userEvent.setup();
  open();
  const space = await card('Space settings kept per environment');
  const pair = within(space).getByRole('checkbox', { name: 'displayType + displayValue' });
  expect(pair).not.toBeChecked();
  await user.click(pair);
  await user.click(within(space).getByRole('button', { name: 'Save space settings' }));
  await waitFor(() => expect(m.callsTo('PUT', '/api/projects/acme-demo/config')).toHaveLength(1));
  expect(lastPut(m)).toEqual({ envBoundSpaceFields: ['displayType', 'displayValue'] });
});

test('space settings: the boxes follow the list the server saved', async () => {
  let config: ProjectConfig = { data: [], exclude: { kapps: [], forms: [] }, envBoundAttributes: {}, envBoundSpaceFields: [] };
  mockApi({
    'GET /api/projects/:p': project(),
    'GET /api/projects/:p/history': [],
    'GET /api/projects/:p/catalog': CATALOG,
    'GET /api/projects/:p/config': () => config,
    // The server stores what it accepts; here it also keeps defaultTimezone.
    'PUT /api/projects/:p/config': (c: { body: Partial<ProjectConfig> }) => {
      config = { ...config, envBoundSpaceFields: [...(c.body.envBoundSpaceFields ?? []), 'defaultTimezone'] };
      return config;
    },
  });
  const user = userEvent.setup();
  open();
  const space = await card('Space settings kept per environment');
  await user.click(within(space).getByRole('checkbox', { name: 'loginPage' }));
  await user.click(within(space).getByRole('button', { name: 'Save space settings' }));
  await waitFor(() => expect(within(space).getByRole('checkbox', { name: 'defaultTimezone' })).toBeChecked());
  expect(within(space).getByRole('checkbox', { name: 'loginPage' })).toBeChecked();
});

test('space settings: a reply without the list (an older server) shows the defaults; saving another card keeps unsaved boxes', async () => {
  const m = setup({});
  const user = userEvent.setup();
  open();
  const space = await card('Space settings kept per environment');
  for (const f of DEFAULT_BOXES) expect(within(space).getByRole('checkbox', { name: f })).toBeChecked();
  await user.click(within(space).getByRole('checkbox', { name: 'defaultTimezone' }));
  const rules = await card('Environment-specific attributes');
  await user.click(within(rules).getByRole('button', { name: 'Save attributes' }));
  await waitFor(() => expect(m.callsTo('PUT', '/api/projects/acme-demo/config')).toHaveLength(1));
  expect(lastPut(m)).not.toHaveProperty('envBoundSpaceFields');
  expect(within(space).getByRole('checkbox', { name: 'defaultTimezone' })).toBeChecked();
});

test('space settings: names ignored in the project file are shown on this card only', async () => {
  setup({
    envBoundSpaceFields: ['trustedFrameDomains'],
    warnings: [
      'kinetic-sync.config.json: "envBoundSpaceFields": "colour" cannot be kept per environment; it is ignored.',
      'kinetic-sync.config.json: "envBoundAttributes": unknown level "forms" (use space, kapp, form, team, category); it is ignored.',
    ],
  });
  open();
  const space = await card('Space settings kept per environment');
  const rules = await card('Environment-specific attributes');
  expect(within(space).getByText(/"colour" cannot be kept per environment/)).toBeInTheDocument();
  expect(within(space).queryByText(/unknown level "forms"/)).toBeNull();
  expect(within(rules).getByText(/unknown level "forms"/)).toBeInTheDocument();
  expect(within(rules).queryByText(/"colour"/)).toBeNull();
  expect(within(space).getByRole('checkbox', { name: 'displayType + displayValue' })).not.toBeChecked();
});
