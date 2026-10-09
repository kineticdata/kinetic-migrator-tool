// Screenshot walkthrough for docs/WALKTHROUGH.md: the built app (`npm run
// build`) started through the CLI in fake mode (synthetic Dev and Test
// spaces, nothing leaves the machine) and driven through a first promotion
// from Dev to Test. Each step writes docs/images/walkthrough/NN-name.png.
// Run with `npm run docs:screenshots`.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'docs', 'images', 'walkthrough');

let server: ChildProcess | undefined;
let workspace = '';
let launchUrl = '';

// Starts the CLI and resolves with the launch URL it prints.
function startCli(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'kinetic-migrate.mjs'), 'ui', '--no-open', '--fake', '--workspace', workspace], {
      cwd: ROOT, env: { ...process.env, KINETIC_MIGRATE_FAKE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server = child;
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no launch URL after 20 s:\n${out}`)), 20_000);
    const read = (chunk: Buffer) => {
      out += chunk.toString();
      const url = /running at (http:\/\/\S+)/.exec(out)?.[1];
      if (url) { clearTimeout(timer); resolve(url); }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`kinetic-migrate ui exited (${code}):\n${out}`)); });
  });
}

// Toasts are hidden unless a shot is about one; no text cursor.
const CALM = `
  [aria-label^="Notifications ("] { visibility: hidden !important; }
  * { caret-color: transparent !important; }
`;

// The temporary workspace path is shown in places (the log file); show the
// default workspace instead so no machine-specific path is in the pictures.
async function genericPaths(page: Page): Promise<void> {
  await page.evaluate((ws) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue?.includes(ws)) n.nodeValue = n.nodeValue.split(ws).join('~/KineticMigrate');
    }
  }, workspace);
}

// A select (when the snapshot lists the choices) or a free-text input.
async function choose(control: Locator, label: string, value: string): Promise<void> {
  if ((await control.evaluate((el) => el.tagName)) === 'SELECT') await control.selectOption({ label }).catch(() => control.selectOption(value));
  else await control.fill(value);
}

let shot = 0;
async function snap(page: Page, name: string, opts: { target?: Locator; toasts?: boolean } = {}): Promise<void> {
  shot += 1;
  const file = path.join(OUT, `${String(shot).padStart(2, '0')}-${name}.png`);
  // Let transitions, spinners and fetches settle so the picture shows the resting state.
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(400);
  await genericPaths(page);
  const style = opts.toasts ? '* { caret-color: transparent !important; }' : CALM;
  if (opts.target) await opts.target.screenshot({ path: file, animations: 'disabled', caret: 'hide', style });
  else await page.screenshot({ path: file, animations: 'disabled', caret: 'hide', style });
}

test.beforeAll(async () => {
  if (!existsSync(path.join(ROOT, 'dist', 'server.mjs'))) throw new Error('dist/ is missing: run `npm run build` (or `npm run docs:screenshots`, which builds first)');
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) if (f.endsWith('.png')) rmSync(path.join(OUT, f));
  workspace = mkdtempSync(path.join(tmpdir(), 'km-walkthrough-'));
  launchUrl = await startCli();
});

test.afterAll(() => {
  server?.removeAllListeners('exit');
  server?.kill();
  if (workspace) rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('walkthrough: your first promotion from Dev to Test', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(launchUrl);
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
  // Fake mode keeps secrets in memory, so the Projects page says no keychain
  // was found; on macOS and Windows the system keychain is used and the note
  // does not show. Leave it out of the picture.
  await page.getByText(/No system keychain was found/).evaluate((el) => { (el as HTMLElement).style.display = 'none'; });
  await snap(page, 'projects-empty');

  await test.step('new project wizard', async () => {
    await page.getByRole('link', { name: 'Create your first project' }).click();
    await page.getByLabel('Project name').fill('Service portal');
    await snap(page, 'wizard-project');
    await page.getByRole('button', { name: 'Next' }).click();

    await page.getByLabel('Space URL').fill('https://dev.example.com');
    await page.getByRole('switch', { name: /Protected/ }).click();
    await page.getByLabel('Username').fill('admin');
    await page.getByLabel('Password').fill('demo-password');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByRole('button', { name: 'Next' })).toBeEnabled();
    await snap(page, 'wizard-environment');
    await page.getByRole('button', { name: 'Next' }).click();

    await page.getByRole('button', { name: 'Take snapshot' }).click();
    await expect(page.getByRole('button', { name: 'Open overview' })).toBeVisible();
    await snap(page, 'wizard-snapshot');
    await page.getByRole('button', { name: 'Open overview' }).click();
  });

  await test.step('add Test', async () => {
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Add environment' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add environment' });
    await dialog.getByLabel('Environment name').fill('test');
    await dialog.getByLabel('Space URL').fill('https://test.example.com');
    await dialog.getByLabel('Username').fill('admin');
    await dialog.getByLabel('Password').fill('demo-password');
    await dialog.getByRole('button', { name: 'Test connection' }).click();
    await expect(dialog.getByText(/Connected/).first()).toBeVisible();
    await snap(page, 'add-environment');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('list', { name: 'Pipeline order' }).getByRole('listitem')).toHaveCount(2);
    await snap(page, 'settings-environments');
  });

  await test.step('overview and snapshots', async () => {
    await page.getByRole('link', { name: 'Overview', exact: true }).click();
    const testEnv = page.getByRole('region', { name: 'Test environment' });
    await expect(testEnv).toBeVisible();
    await snap(page, 'overview-before-snapshot');
    await testEnv.getByRole('button', { name: 'Take snapshot' }).click();
    await expect(testEnv.getByText('Taken just now')).toBeVisible();
    await expect(page.getByText('Comparing…')).toHaveCount(0);
    await snap(page, 'overview');
  });

  await test.step('explore', async () => {
    await page.getByRole('link', { name: 'Explore', exact: true }).first().click();
    const tree = page.getByRole('tree').first();
    await expect(tree).toBeVisible();
    for (const name of [/^Kapps/, /^Services/, /^Forms/]) {
      const row = tree.getByRole('treeitem', { name }).first();
      if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
    }
    await tree.getByRole('treeitem', { name: /^IT Request/ }).first().click();
    await expect(page.getByRole('heading', { name: 'IT Request' }).first()).toBeVisible();
    await snap(page, 'explore');
    await page.getByRole('tab', { name: /^Relationships/ }).click();
    await snap(page, 'explore-relationships');
  });

  const tree = page.getByRole('tree', { name: 'Differences, Dev to Test' });
  const tray = page.getByRole('complementary');

  await test.step('compare', async () => {
    await page.getByRole('link', { name: 'Overview', exact: true }).click();
    await page.getByRole('link', { name: 'Compare with Test' }).click();
    await expect(tree.getByRole('treeitem', { name: /^Kapps/ })).toBeVisible();
    await page.getByRole('button', { name: 'Expand all' }).click();
    await expect(tree.getByRole('treeitem', { name: /^IT Request/ })).toBeVisible();
    await snap(page, 'compare');
    await tree.getByRole('treeitem', { name: /^IT Request/ }).click();
    await expect(page.getByRole('heading', { name: 'IT Request', level: 2 })).toBeVisible();
    await snap(page, 'compare-field-diff');
  });

  await test.step('changeset and suggestions', async () => {
    await tree.getByRole('treeitem', { name: /^IT Request/ }).locator('[data-check]').click();
    await tree.getByRole('treeitem', { name: /^Mail Send/ }).locator('[data-check]').click();
    const suggested = tray.getByRole('region', { name: 'Suggested' });
    await expect(suggested.getByText('Ticketing', { exact: true })).toBeVisible();
    await snap(page, 'compare-suggestions');
    await suggested.getByRole('button', { name: 'Add all' }).click();
    await expect(suggested).toBeHidden();
    await snap(page, 'changeset-tray');

    const team = tree.getByRole('treeitem', { name: /^Contractors/ });
    await team.click();
    await page.getByRole('button', { name: 'Remove from Test' }).click();
    const removal = tray.getByRole('region', { name: 'Remove from Test' });
    await expect(removal.getByText('Contractors')).toBeVisible();
    await removal.scrollIntoViewIfNeeded();
    await snap(page, 'remove-from-target');

    await tray.getByRole('button', { name: /Save as changeset/ }).click();
    const save = page.getByRole('dialog', { name: 'Save as changeset' });
    await save.getByLabel('Name').fill('IT Request ticketing');
    await save.getByLabel('Description').fill('IT Request form, its ticketing connection and the Mail Send handler. Removes the old Contractors team.');
    await snap(page, 'save-changeset');
    await save.getByRole('button', { name: 'Save changeset' }).click();
    await expect(save).toBeHidden();
    await tray.getByRole('button', { name: 'Review plan' }).click();
  });

  await test.step('plan', async () => {
    const attention = page.getByRole('region', { name: 'Needs attention' });
    await expect(attention.getByRole('checkbox').first()).toBeVisible();
    await snap(page, 'plan-review');
    await attention.scrollIntoViewIfNeeded();
    await snap(page, 'plan-needs-attention', { target: attention });
    for (const box of await attention.getByRole('checkbox').all()) await box.check();
    await page.getByRole('button', { name: 'Next: Environment values' }).click();
    await page.getByLabel('Server in Test').fill('smtp.test.example.com');
    await snap(page, 'plan-environment-values');
    await page.getByRole('button', { name: 'Next: Confirm' }).click();
    await page.getByLabel('Type test to confirm').fill('test');
    await page.getByRole('button', { name: 'Apply to Test' }).scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 400);
    await snap(page, 'plan-confirm');
  });

  await test.step('apply', async () => {
    await page.getByRole('button', { name: 'Apply to Test' }).click();
    await expect(page.getByRole('heading', { name: 'Applied to Test' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Progress' }).getByRole('status')).toContainText('done');
    await snap(page, 'apply-done');
  });

  await test.step('history and restore', async () => {
    await page.getByRole('link', { name: 'View in History' }).click();
    const timeline = page.getByRole('list', { name: 'Timeline' });
    const applied = timeline.getByRole('button', { name: /Applied .* to Test/ }).first();
    await expect(applied).toBeVisible();
    await applied.click();
    await snap(page, 'history');
    await timeline.getByRole('button', { name: /Backup of Test before applying/ }).first().click();
    await page.getByRole('button', { name: 'Restore…' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await snap(page, 'restore-preview');
  });

  await test.step('changesets', async () => {
    await page.getByRole('link', { name: 'Changesets', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Changesets' }).or(page.getByRole('list', { name: 'Changesets' }))).toBeVisible();
    await snap(page, 'changesets');
  });

  await test.step('settings', async () => {
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('link', { name: 'Data & values' }).click();
    await expect(page.getByText('Space settings kept per environment')).toBeVisible();
    await snap(page, 'settings-space-settings');

    const card = (title: string) => page.locator('section, div').filter({ has: page.getByRole('heading', { name: title }) }).filter({ has: page.getByRole('button', { name: /^Save / }) }).last();
    const attributes = card('Environment-specific attributes');
    await attributes.getByRole('button', { name: 'Add rule' }).click();
    await page.getByLabel('Level for rule 1').selectOption('space');
    await page.getByLabel('Attribute for rule 1').fill('Web Server Url');
    await attributes.getByRole('button', { name: 'Add rule' }).click();
    await page.getByLabel('Level for rule 2').selectOption('kapp');
    await page.getByLabel('Attribute for rule 2').fill('Notification Email');
    await attributes.getByRole('button', { name: 'Save attributes' }).click();
    await attributes.scrollIntoViewIfNeeded();
    await snap(page, 'settings-attributes', { target: attributes });

    const reference = card('Reference data');
    await reference.getByRole('button', { name: 'Add entry' }).click();
    await choose(page.getByLabel('Kapp for entry 1'), 'Facilities', 'facilities');
    await choose(page.getByLabel('Form for entry 1'), 'Room Booking', 'room-booking');
    await reference.getByRole('checkbox', { name: 'Room', exact: true }).check();
    await reference.scrollIntoViewIfNeeded();
    await snap(page, 'settings-reference-data', { target: reference });
    await page.getByRole('link', { name: 'Repository' }).click();
    await expect(page.getByText('Remote repository')).toBeVisible();
    await snap(page, 'settings-repository');
  });

  await test.step('dark theme', async () => {
    await page.getByRole('link', { name: 'Overview', exact: true }).click();
    await page.getByRole('link', { name: 'Compare with Test' }).click();
    await expect(tree.getByRole('treeitem', { name: /^Kapps/ })).toBeVisible();
    await page.getByRole('button', { name: 'Theme' }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await page.getByRole('button', { name: 'Expand all' }).click();
    await tree.getByRole('treeitem', { name: /^Maintenance/ }).click();
    await snap(page, 'dark-compare');
  });

  expect(errors).toEqual([]);
});
