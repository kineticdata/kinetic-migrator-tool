// End-to-end smoke test: the built app (`npm run build`) started through the
// CLI (`kinetic-migrate ui --no-open`) in fake mode (KINETIC_MIGRATE_FAKE=1:
// synthetic dev and test spaces, nothing leaves the machine), driven through
// the main journey. A screenshot of every step goes to e2e-artifacts/screenshots.
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'e2e-artifacts', 'screenshots');

let server: ChildProcess | undefined;
let workspace = '';
let launchUrl = '';

// Starts the CLI and resolves with the launch URL it prints.
function startCli(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'kinetic-migrate.mjs'), 'ui', '--no-open', '--workspace', workspace], {
      cwd: ROOT, env: { ...process.env, KINETIC_MIGRATE_FAKE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    server = child;
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no launch URL after 20 s:\n${out}`)), 20_000);
    const read = (chunk: Buffer) => {
      out += chunk.toString();
      const url = /running at (http:\/\/\S+)/.exec(out)?.[1];
      if (url) {
        clearTimeout(timer);
        if (!/fake mode/i.test(out)) setTimeout(() => { if (!/fake mode/i.test(out)) reject(new Error(`server is not in fake mode:\n${out}`)); }, 500);
        resolve(url);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`kinetic-migrate ui exited (${code}):\n${out}`)); });
  });
}

let shot = 0;
async function snap(page: Page, name: string): Promise<void> {
  shot += 1;
  // Let transitions and toasts settle so the picture shows the resting state.
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${String(shot).padStart(2, '0')}-${name}.png`), fullPage: true });
}

test.beforeAll(async () => {
  if (!existsSync(path.join(ROOT, 'dist', 'server.mjs'))) throw new Error('dist/ is missing: run `npm run build` (or `npm run test:e2e`, which builds first)');
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  workspace = mkdtempSync(path.join(tmpdir(), 'km-e2e-'));
  launchUrl = await startCli();
});

test.afterAll(() => {
  server?.removeAllListeners('exit');
  server?.kill();
  if (workspace) rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('create a project, compare dev with test, promote a form and its dependencies, see it in history', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(launchUrl);
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
  await snap(page, 'projects-empty');

  await test.step('create a project with dev, add test, snapshot both', async () => {
    await page.getByRole('link', { name: 'Create your first project' }).click();
    await page.getByLabel('Project name').fill('Service portal');
    await snap(page, 'wizard-project');
    await page.getByRole('button', { name: 'Next' }).click();

    await page.getByLabel('Space URL').fill('https://dev.example.com');
    await page.getByLabel('Username').fill('admin');
    await page.getByLabel('Password').fill('demo-password');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByRole('button', { name: 'Next' })).toBeEnabled();
    await snap(page, 'wizard-environment');
    await page.getByRole('button', { name: 'Next' }).click();

    await page.getByRole('button', { name: 'Take snapshot' }).click();
    await expect(page.getByRole('button', { name: 'Open overview' })).toBeVisible();
    await snap(page, 'wizard-snapshot-done');
    await page.getByRole('button', { name: 'Open overview' }).click();

    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Add environment' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add environment' });
    await dialog.getByLabel('Environment name').fill('test');
    await dialog.getByLabel('Space URL').fill('https://test.example.com');
    await dialog.getByLabel('Username').fill('admin');
    await dialog.getByLabel('Password').fill('demo-password');
    await dialog.getByRole('button', { name: 'Test connection' }).click();
    await snap(page, 'add-environment');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('list', { name: 'Pipeline order' }).getByRole('listitem')).toHaveCount(2);
    await snap(page, 'settings-environments');

    await page.getByRole('link', { name: 'Overview', exact: true }).click();
    const testEnv = page.getByRole('region', { name: 'Test environment' });
    await testEnv.getByRole('button', { name: 'Take snapshot' }).click();
    await expect(testEnv.getByText('Taken just now')).toBeVisible();
    await snap(page, 'overview');
  });

  await test.step('explore dev', async () => {
    await page.getByRole('link', { name: 'Explore', exact: true }).first().click();
    await expect(page.getByRole('tree').first()).toBeVisible();
    await snap(page, 'explore');
  });

  await test.step('compare dev with test, tick a form and accept the suggestion', async () => {
    await page.getByRole('link', { name: 'Overview', exact: true }).click();
    await page.getByRole('link', { name: 'Compare with Test' }).click();
    const tree = page.getByRole('tree', { name: 'Differences, Dev to Test' });
    await expect(tree.getByRole('treeitem', { name: /^Kapps/ })).toBeVisible();
    await snap(page, 'compare');
    await page.getByRole('button', { name: 'Expand all' }).click();
    const form = tree.getByRole('treeitem', { name: /^IT Request/ });
    await form.click();
    await snap(page, 'compare-item-detail');
    await form.locator('[data-check]').click();
    await tree.getByRole('treeitem', { name: /^Mail Send/ }).locator('[data-check]').click();
    const tray = page.getByRole('complementary');
    const suggested = tray.getByRole('region', { name: 'Suggested' });
    await expect(suggested.getByText('Ticketing', { exact: true })).toBeVisible();
    // Mail Send's Task category, so the handler shows in the workflow builder.
    await expect(suggested.getByText('Notifications', { exact: true })).toBeVisible();
    await snap(page, 'compare-suggestion');
    await suggested.getByRole('button', { name: 'Add all' }).click();
    await expect(suggested).toBeHidden();
    await expect(tray.getByRole('region', { name: 'Connections' })).toBeVisible();
    await snap(page, 'compare-changeset');
    await tray.getByRole('button', { name: 'Review plan' }).click();
  });

  await test.step('review, acknowledge, values, confirm, apply', async () => {
    const attention = page.getByRole('region', { name: 'Needs attention' });
    await expect(attention.getByRole('checkbox').first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Summary' })).toContainText('create');
    await snap(page, 'plan-review');
    for (const box of await attention.getByRole('checkbox').all()) await box.check();
    await page.getByRole('button', { name: 'Next: Environment values' }).click();

    await page.getByLabel('Server in Test').fill('smtp.test.example.com');
    await snap(page, 'plan-values');
    await page.getByRole('button', { name: 'Next: Confirm' }).click();

    await page.getByLabel('Type test to confirm').fill('test');
    await snap(page, 'plan-confirm');
    await page.getByRole('button', { name: 'Apply to Test' }).click();
    await expect(page.getByRole('heading', { name: 'Applied to Test' })).toBeVisible();
    const progress = page.getByRole('region', { name: 'Progress' });
    await expect(progress.getByRole('status')).toContainText('done');
    for (const item of ['Ticketing', 'Mail Send', 'Notify Requester', 'Notifications', 'IT Request']) {
      await expect(progress.getByRole('listitem', { name: `${item}: Done` })).toBeVisible();
    }
    await snap(page, 'apply-done');
  });

  await test.step('history shows the apply', async () => {
    await page.getByRole('link', { name: 'View in History' }).click();
    const timeline = page.getByRole('list', { name: 'Timeline' });
    const applied = timeline.getByRole('button', { name: /Applied '7 items from Dev' to Test/ });
    await expect(applied).toBeVisible();
    await expect(timeline.getByRole('button', { name: /Backup of Test before applying/ })).toBeVisible();
    await applied.click();
    await snap(page, 'history');
  });

  await test.step('a fresh snapshot of test no longer differs on what was promoted', async () => {
    await page.getByRole('link', { name: 'Overview', exact: true }).click();
    const testEnv = page.getByRole('region', { name: 'Test environment' });
    await testEnv.getByRole('button', { name: 'Refresh snapshot' }).click();
    await expect(page.getByText(/Snapshot of Test taken/).first()).toBeVisible();
    await page.getByRole('link', { name: 'Compare with Test' }).click();
    const tree = page.getByRole('tree', { name: 'Differences, Dev to Test' });
    await expect(tree.getByRole('treeitem', { name: /^Kapps/ })).toBeVisible();
    await page.getByRole('button', { name: 'Expand all' }).click();
    // Not promoted: still different. Promoted: gone (the connection stays as
    // the parent of its unpromoted operation).
    for (const left of [/^Leave Request/, /^Get Ticket/]) await expect(tree.getByRole('treeitem', { name: left })).toBeVisible();
    for (const gone of [/^IT Request/, /^Create Ticket/, /^Mail Send/]) await expect(tree.getByRole('treeitem', { name: gone })).toHaveCount(0);
    await snap(page, 'compare-after-apply');
  });

  await test.step('remove a team that is only in test', async () => {
    const tree = page.getByRole('tree', { name: 'Differences, Dev to Test' });
    const team = tree.getByRole('treeitem', { name: /^Contractors/ });
    await team.click();
    await page.getByRole('button', { name: 'Remove from Test' }).click();
    const tray = page.getByRole('complementary');
    await expect(tray.getByRole('region', { name: 'Remove from Test' }).getByText('Contractors')).toBeVisible();
    await snap(page, 'compare-removal');
    await tray.getByRole('button', { name: 'Review plan' }).click();
    const removals = page.getByRole('region', { name: 'Remove from Test' });
    await expect(removals.getByText('Contractors', { exact: true })).toBeVisible();
    await expect(removals).toContainText('memberships');
    await snap(page, 'plan-removal');
    await page.getByRole('button', { name: 'Next: Environment values' }).click();
    await page.getByRole('button', { name: 'Next: Confirm' }).click();
    await expect(page.getByRole('region', { name: 'Removals from Test' })).toContainText('1 item will be removed from Test');
    await page.getByLabel('Type test to confirm').fill('test');
    await snap(page, 'confirm-removal');
    await page.getByRole('button', { name: 'Apply to Test' }).click();
    await expect(page.getByRole('heading', { name: 'Applied to Test' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Progress' }).getByRole('listitem', { name: /^Contractors: Done/ })).toBeVisible();
    await page.getByRole('link', { name: 'View in History' }).click();
    await expect(page.getByRole('list', { name: 'Timeline' }).getByRole('button', { name: /Removed 1 item from Test/ })).toBeVisible();
    await snap(page, 'history-removal');
    await page.getByRole('link', { name: 'Overview', exact: true }).click();
    await page.getByRole('link', { name: 'Compare with Test' }).click();
    await expect(page.getByRole('tree', { name: 'Differences, Dev to Test' }).getByRole('treeitem', { name: /^Kapps/ })).toBeVisible();
  });

  await test.step('dark theme', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await expect(page.getByRole('tree', { name: 'Differences, Dev to Test' })).toBeVisible();
    await snap(page, 'dark-compare');
    await page.getByRole('link', { name: 'Overview', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Test environment' })).toBeVisible();
    await snap(page, 'dark-overview');
  });

  expect(errors).toEqual([]);
});
