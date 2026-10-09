// Plans and guided apply, end to end against fake Dev/Test spaces:
// snapshot → compare → suggestions → plan with a selection → apply writes only
// the selected keys, with a backup, a run record, commits and no secret leaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ApplyResult, Changeset, PlanResult, RunRecord } from '../shared/sync-api.ts';
import { log, readTreeAt, managedRepo } from './repo.ts';
import { PLANTED, PLANTED_CONN, PLANTED_RUN, assertNoSecret, harness, type Harness } from './sync-fixtures.ts';

const P = '/api/projects/sync-test';
const FORM = 'kapps/services/forms/it-request/form';
const OP = 'connections/Ticketing/operations/Create Ticket';
const CONN = 'connections/Ticketing/connection';
const SECRET_ID = 'secret/TICKETING__PASSWORD';

async function plan(h: Harness, body: unknown): Promise<PlanResult> {
  const job = await h.job('POST', `${P}/plans`, body);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  return job.result as PlanResult;
}

async function repoText(h: Harness): Promise<string> {
  const head = (await log(managedRepo(h.dir), { limit: 1 }))[0];
  const tree = await readTreeAt(managedRepo(h.dir), head.oid, '');
  return JSON.stringify([...tree]) + (await log(managedRepo(h.dir), { limit: 1000 })).map((e) => e.message).join('\n');
}

test('guided apply writes only the selected keys, backs up first, records the run and never leaks a secret', async (t) => {
  const h = await harness(t);
  await h.call('PUT', `${P}/config`, { envBoundAttributes: { form: ['Owner'] } });
  for (const env of ['dev', 'test']) assert.equal((await h.job('POST', `${P}/snapshots`, { env })).status, 'succeeded');
  const cmp = (await h.job('POST', `${P}/compare`, { from: 'dev', to: 'test', mode: 'preview' })).result;
  const sug = (await h.call('POST', `${P}/compare/${cmp.compareId}/suggestions`, { selected: [FORM] })).json;
  assert.deepEqual(sug.map((s: any) => s.key), [CONN, OP]);

  // Without the suggested dependencies the plan has an error and cannot be applied.
  const partial = await plan(h, { to: 'test', from: 'dev', selected: [FORM] });
  assert.ok(partial.errors.some((e) => e.includes('Create Ticket') || e.includes('o-1')), JSON.stringify(partial.errors));
  const refused = await h.call('POST', `${P}/plans/${partial.planId}/apply`, { acknowledgements: [], confirm: 'test' });
  assert.equal(refused.status, 409);

  const p = await plan(h, { to: 'test', from: 'dev', selected: [FORM, ...sug.map((s: any) => s.key)] });
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.items.map((i) => [i.key, i.action]), [[CONN, 'create'], [OP, 'create'], [FORM, 'update']]);
  assert.equal(p.counts.create, 2);
  assert.equal(p.counts.update, 1);
  assert.deepEqual(p.needsAttention.map((n) => n.id).sort(), [`connection-secrets:${CONN}`, `index:${FORM}`]);
  assert.deepEqual(p.secretsNeeded.map((s) => [s.id, s.has]), [[SECRET_ID, false]]);
  const owner = p.environmentValues.find((v) => v.label === 'Owner')!;
  assert.deepEqual([owner.key, owner.path, owner.required], [FORM, 'attributes.Owner', true]);
  assert.equal((await h.call('GET', `${P}/plans/${p.planId}`)).json.planId, p.planId);

  const apply = (body: unknown) => h.call('POST', `${P}/plans/${p.planId}/apply`, body);
  const values = { [FORM]: { 'attributes.Owner': ['IT'] } };
  const secrets = { [SECRET_ID]: PLANTED_RUN };
  // Refusals: confirmation, acknowledgements, required values, unknown secrets.
  assert.equal((await apply({ acknowledgements: [`index:${FORM}`], values, secrets, confirm: 'Test' })).json.error.code, 'confirmation_required');
  const noAck = await apply({ acknowledgements: [], values, confirm: 'test' });
  assert.equal(noAck.status, 400);
  assert.equal(noAck.json.error.code, 'acknowledgement_required');
  assert.deepEqual(noAck.json.error.detail.missing.sort(), [`connection-secrets:${CONN}`, `index:${FORM}`]);
  const noValues = await apply({ acknowledgements: [`index:${FORM}`], secrets, confirm: 'test' });
  assert.equal(noValues.json.error.code, 'values_required');
  assert.equal((await apply({ acknowledgements: [`index:${FORM}`], values, secrets: { 'secret/OTHER': 'x' }, confirm: 'test' })).status, 400);
  assert.deepEqual(h.writes('test'), [], 'nothing written by refused applies');
  const commitsBefore = (await log(managedRepo(h.dir), { limit: 1000 })).length;

  // Secrets given for this run stand in for the connection acknowledgement.
  const started = await apply({ acknowledgements: [`index:${FORM}`], values, secrets, confirm: 'test' });
  assert.equal(started.status, 202, started.body);
  await h.server.jobs.wait(started.json.jobId);
  const info = (await h.call('GET', `/api/jobs/${started.json.jobId}`)).json;
  const events = (await h.call('GET', `/api/jobs/${started.json.jobId}/events`)).body;
  assert.equal(info.status, 'succeeded', JSON.stringify(info.error));
  const result = info.result as ApplyResult;
  assert.equal(result.status, 'applied', String(result.error));
  assert.match(events, /"step":"backup"/);
  assert.match(events, /event: item/);

  // Only the selected keys were written (the changed team was not).
  assert.deepEqual(h.writes('test'), [
    'POST /import/connections', 'POST /import/connections/c-1/operations',
    'PUT /kapps/services/forms/it-request', 'POST /kapps/services/forms/it-request/backgroundJobs',
  ]);
  assert.deepEqual(h.writes('dev'), []);
  const connWrite = h.calls.find((c) => c.path === '/import/connections')!;
  assert.equal((connWrite.body as any).config.auth.password, PLANTED_RUN, 'the run secret reached the target');
  const formWrite = h.calls.find((c) => c.method === 'PUT' && c.path === '/kapps/services/forms/it-request')!;
  assert.deepEqual((formWrite.body as any).attributes, [{ name: 'Owner', values: ['IT'] }]);
  const sid = JSON.parse(readFileSync(path.join(h.dir, 'kinetic-migrate.json'), 'utf8')).secretsId;
  assert.equal(await h.store.has(`${sid}/test/secret/TICKETING__PASSWORD`), false, 'not remembered');

  // Values saved, backup and run committed, run record written.
  assert.deepEqual(JSON.parse(readFileSync(path.join(h.dir, 'overrides', 'test.json'), 'utf8')).artifacts[FORM], { 'attributes.Owner': ['IT'] });
  const messages = (await log(managedRepo(h.dir), { limit: 1000 })).slice(0, -commitsBefore).map((e) => e.message.split('\n')[0]);
  assert.deepEqual(messages, ["Applied '3 items from Dev' to Test", "Backup of Test before applying '3 items from Dev'", 'Updated environment values for Test']);
  assert.ok(result.backupCommit);
  const runFile = readdirSync(path.join(h.dir, 'runs'));
  assert.equal(runFile.length, 1);
  const run = JSON.parse(readFileSync(path.join(h.dir, 'runs', runFile[0]), 'utf8')) as RunRecord;
  assert.equal(run.id, result.runId);
  assert.deepEqual([run.status, run.to, run.from, run.backupCommit], ['applied', 'test', 'dev', result.backupCommit]);
  assert.deepEqual(run.selection, [CONN, OP, FORM].sort());
  assert.deepEqual(run.secretsUsed, [SECRET_ID]);
  assert.deepEqual(run.items.map((i) => [i.key, i.status]), [[CONN, 'done'], [OP, 'done'], [FORM, 'done']]);
  assert.equal(run.source.commit, p.sourceCommit);
  assert.ok(existsSync(path.join(h.dir, 'state', 'test.json')));

  assertNoSecret(h, [events]);
  const repo = await repoText(h);
  assert.ok(![PLANTED, PLANTED_RUN, PLANTED_CONN].some((x) => repo.includes(x)), 'no secret in the repository');
});

test('remembered secrets go to the store; a readOnly target is refused; a changeset records where it was applied', async (t) => {
  const h = await harness(t);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });

  // Protected (read-only) target: planning works, applying is refused.
  const toProd = await plan(h, { to: 'prod', from: 'dev', selected: ['teams/Ops'] });
  const ro = await h.call('POST', `${P}/plans/${toProd.planId}/apply`, { acknowledgements: [], confirm: 'prod' });
  assert.equal(ro.status, 403);
  assert.equal(ro.json.error.code, 'read_only');
  assert.deepEqual(h.writes(), []);

  const cs = (await h.call('POST', `${P}/changesets`, { name: 'Team text', from: 'dev', keys: ['teams/Ops', CONN] })).json as Changeset;
  const p = await plan(h, { to: 'test', changesetId: cs.id });
  assert.equal(p.name, 'Team text');
  assert.equal(p.changesetId, cs.id);
  assert.equal(p.sourceCommit, cs.sourceCommit);
  const job = await h.job('POST', `${P}/plans/${p.planId}/apply`, { acknowledgements: [], secrets: { [SECRET_ID]: PLANTED_RUN }, remember: true, confirm: 'test' });
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  assert.equal(job.result.status, 'applied', job.result.error);
  assert.deepEqual(h.writes('test'), ['PUT /teams/ops', 'POST /import/connections']);
  assert.equal(await h.store.has(`${JSON.parse(readFileSync(path.join(h.dir, 'kinetic-migrate.json'), 'utf8')).secretsId}/test/secret/TICKETING__PASSWORD`), true);
  const saved = (await h.call('GET', `${P}/changesets/${cs.id}`)).json as Changeset;
  assert.deepEqual(saved.appliedTo.map((a) => [a.env, a.runId]), [['test', job.result.runId]]);
  assert.match((await log(managedRepo(h.dir), { limit: 1 }))[0].message, /^Applied 'Team text' to Test\n\nEnvironment: test\nRun: .+\nChangeset: /);
  assert.equal((await h.call('POST', `${P}/plans/nope/apply`, { confirm: 'test' })).status, 404);
  assertNoSecret(h, [job.events]);
});

test('a failed item stops the apply: partial run record, plain error, then resume re-plans and continues', async (t) => {
  const h = await harness(t);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  const p = await plan(h, { to: 'test', from: 'dev', selected: ['teams/Ops', FORM, CONN, OP] });
  const original = h.spaces.test;
  h.spaces.test = () => ({ ...original(), 'PUT core/kapps/services/forms/it-request': () => { const e = new Error(`PUT https://test.example.com/x failed with 500: ${PLANTED}`); throw Object.assign(e, { name: 'HttpError', status: 500 }); } });
  const body = { acknowledgements: [`index:${FORM}`, `connection-secrets:${CONN}`], values: {}, confirm: 'test' };
  const first = await h.job('POST', `${P}/plans/${p.planId}/apply`, body);
  // Required env values: none configured here.
  assert.equal(first.status, 'succeeded', JSON.stringify(first.error));
  assert.equal(first.result.status, 'partial');
  assert.equal(first.result.error, `${FORM}: The Kinetic Platform returned an error (500).`);
  assert.match((await log(managedRepo(h.dir), { limit: 1 }))[0].message, /^Partly applied/);
  const run = JSON.parse(readFileSync(path.join(h.dir, 'runs', `${first.result.runId}.json`), 'utf8')) as RunRecord;
  assert.equal(run.status, 'partial');
  assert.equal(run.items.find((i) => i.key === FORM)!.status, 'failed');

  h.spaces.test = original;
  const resumed = await h.job('POST', `${P}/plans/${p.planId}/apply`, body);
  assert.equal(resumed.result.status, 'applied', resumed.result.error);
  assertNoSecret(h, [first.events, resumed.events]);
});

test('a cancelled apply finishes with its real outcome: run record, backup, items done so far and a plain commit', async (t) => {
  const h = await harness(t);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  const p = await plan(h, { to: 'test', from: 'dev', selected: ['teams/Ops', FORM, CONN, OP] });
  const original = h.spaces.test;
  let jobId = '';
  // Cancel while the first item (the team) is being written.
  h.spaces.test = () => ({ ...original(), 'PUT core/teams/ops': () => { h.server.jobs.abort(jobId); return { team: {} }; } });
  const started = await h.call('POST', `${P}/plans/${p.planId}/apply`, { acknowledgements: [`index:${FORM}`, `connection-secrets:${CONN}`], confirm: 'test' });
  assert.equal(started.status, 202);
  jobId = started.json.jobId;
  await h.server.jobs.wait(jobId);
  const job = (await h.call('GET', `/api/jobs/${jobId}`)).json;
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  const result = job.result as ApplyResult;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error, 'The apply was cancelled.');
  assert.equal(result.done, 1);
  assert.ok(result.backupCommit);
  assert.ok(result.runId);
  assert.match((await log(managedRepo(h.dir), { limit: 1 }))[0].message, /^Cancelled applying '4 items from Dev' to Test/);
  const run = JSON.parse(readFileSync(path.join(h.dir, 'runs', `${result.runId}.json`), 'utf8')) as RunRecord;
  assert.equal(run.status, 'cancelled');
  assert.deepEqual(run.items, [{ key: 'teams/Ops', status: 'done' }]);
  // The lock is released: the same target can be applied to again.
  const again = await h.job('POST', `${P}/plans/${p.planId}/apply`, { acknowledgements: [`index:${FORM}`, `connection-secrets:${CONN}`], confirm: 'test' });
  assert.equal(again.result.status, 'applied', again.result.error);
});

test('an item changed in the target after review is reported as skipped with a reason, and the run is partial', async (t) => {
  const h = await harness(t);
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  const acks = { acknowledgements: [`connection-secrets:${CONN}`], confirm: 'test' };
  // A first promotion records the team's state in Test.
  const first = await plan(h, { to: 'test', from: 'dev', selected: ['teams/Ops'] });
  assert.equal((await h.job('POST', `${P}/plans/${first.planId}/apply`, { acknowledgements: [], confirm: 'test' })).result.status, 'applied');

  // Reviewed: the team is an update (no drift) and the connection a create.
  const p = await plan(h, { to: 'test', from: 'dev', selected: ['teams/Ops', CONN] });
  assert.deepEqual(p.items.map((i) => [i.key, i.action, i.drift]), [[CONN, 'create', false], ['teams/Ops', 'update', false]]);

  // Then someone edits the team in Test before Apply.
  const original = h.spaces.test;
  h.spaces.test = () => ({ ...original(), 'GET core/teams': { teams: [{ name: 'Ops', slug: 'ops', description: 'Edited in Test' }] } });
  const job = await h.job('POST', `${P}/plans/${p.planId}/apply`, acks);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  const result = job.result as ApplyResult;
  assert.equal(result.status, 'partial');
  assert.equal(result.done, 1);
  assert.match(String(result.error), /not applied/);
  assert.deepEqual(h.writes('test').filter((w) => w.includes('teams')), ['PUT /teams/ops'], 'only the first promotion wrote the team');
  const reason = 'Changed in Test since you reviewed it — not applied.';
  assert.match(job.events, new RegExp(`"key":"teams/Ops","status":"skipped","message":"${reason}"|"message":"${reason}"[^}]*"key":"teams/Ops"`));
  const run = JSON.parse(readFileSync(path.join(h.dir, 'runs', `${result.runId}.json`), 'utf8')) as RunRecord;
  assert.equal(run.status, 'partial');
  assert.deepEqual(run.items, [{ key: CONN, status: 'done' }, { key: 'teams/Ops', status: 'skipped', message: reason }]);
  assert.match((await log(managedRepo(h.dir), { limit: 5 })).map((e) => e.message).join('\n'), /^Partly applied '2 items from Dev' to Test/m);

  // Keeping the target's version on purpose is not a skip to report.
  const kept = await h.job('POST', `${P}/plans/${p.planId}/apply`, { ...acks, resolutions: { 'teams/Ops': 'keep' } });
  assert.equal(kept.result.status, 'applied', kept.result.error);
  assert.doesNotMatch(kept.events, /"status":"skipped"/);
  assertNoSecret(h, [job.events, kept.events]);
});

// Test is served from a store that keeps what the apply writes to its team.
function persistingTeam(h: Harness, opts: { failSecondReadAfterWrite?: boolean } = {}): void {
  let team: Record<string, unknown> = { name: 'Ops', slug: 'ops', description: 'Operations' };
  let readsAfterWrite = -1;
  const original = h.spaces.test;
  h.spaces.test = () => {
    const routes = original();
    const space = routes['GET core/space'];
    return {
      ...routes,
      'GET core/space': () => {
        if (readsAfterWrite >= 0 && ++readsAfterWrite >= 2 && opts.failSecondReadAfterWrite) throw Object.assign(new Error('GET https://test.example.com/x failed with 503'), { status: 503 });
        return structuredClone(space);
      },
      'GET core/teams': () => ({ teams: [structuredClone(team)] }),
      'PUT core/teams/ops': ({ body }: { body: Record<string, unknown> }) => {
        team = { ...team, ...body };
        readsAfterWrite = 0;
        return { team };
      },
    };
  };
}

test('after an apply the target is snapshotted again, so a snapshot compare shows the promoted item as same, not drifted', async (t) => {
  const h = await harness(t);
  persistingTeam(h);
  for (const env of ['dev', 'test']) await h.job('POST', `${P}/snapshots`, { env });
  const before = (await h.job('POST', `${P}/compare`, { from: 'dev', to: 'test', mode: 'preview', useSnapshots: true })).result;
  const itemStatus = async (compareId: string) => (await h.call('GET', `${P}/compare/${compareId}/item?key=${encodeURIComponent('teams/Ops')}`)).json.status;
  assert.equal(await itemStatus(before.compareId), 'changed');

  const p = await plan(h, { to: 'test', from: 'dev', selected: ['teams/Ops'] });
  const job = await h.job('POST', `${P}/plans/${p.planId}/apply`, { acknowledgements: [], confirm: 'test' });
  assert.equal(job.result.status, 'applied', job.result.error);
  assert.match(job.events, /"step":"snapshot","status":"done"/);

  // The newest commit is the post-apply snapshot: a snapshot event in History,
  // and the environment's last snapshot.
  const [newest] = await log(managedRepo(h.dir), { limit: 1 });
  assert.equal(newest.message.split('\n')[0], "Snapshot of Test after applying '1 item from Dev'");
  const history = (await h.call('GET', `${P}/history?type=snapshot&env=test`)).json as Array<{ commit: string; title: string }>;
  assert.equal(history[0].commit, newest.oid);
  const project = (await h.call('GET', P)).json;
  assert.equal(project.environments.find((e: any) => e.name === 'test').lastSnapshot.commit, newest.oid);
  assert.equal(job.result.snapshotCommit, newest.oid);
  assert.deepEqual((await readTreeAt(managedRepo(h.dir), newest.oid, 'snapshots/test')).get('teams/Ops'), { name: 'Ops', description: 'Operations (dev)' });

  const after = (await h.job('POST', `${P}/compare`, { from: 'dev', to: 'test', mode: 'preview', useSnapshots: true })).result;
  assert.equal(await itemStatus(after.compareId), 'same');

  // Applying again finds the team already up to date: reported, still applied.
  const again = await h.job('POST', `${P}/plans/${p.planId}/apply`, { acknowledgements: [], confirm: 'test' });
  assert.equal(again.result.status, 'applied', again.result.error);
  assert.match(again.events, /"key":"teams\/Ops","status":"skipped","message":"Already up to date in Test."/);
  assertNoSecret(h, [job.events, again.events]);
});

test('a failed post-apply snapshot is a warning: the apply still reports its real outcome', async (t) => {
  const h = await harness(t);
  persistingTeam(h, { failSecondReadAfterWrite: true });
  await h.job('POST', `${P}/snapshots`, { env: 'dev' });
  const p = await plan(h, { to: 'test', from: 'dev', selected: ['teams/Ops'] });
  const job = await h.job('POST', `${P}/plans/${p.planId}/apply`, { acknowledgements: [], confirm: 'test' });
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  assert.equal(job.result.status, 'applied', job.result.error);
  assert.equal(job.result.snapshotCommit, null);
  assert.match(job.events, /"step":"snapshot","status":"failed"/);
  assert.match(job.events, /could not take a new snapshot of Test/);
  assert.match((await log(managedRepo(h.dir), { limit: 1 }))[0].message, /^Applied '1 item from Dev' to Test/);
  assert.ok(h.logged.some((l) => l.includes('snapshot after apply')));
  assert.ok(!readdirSync(path.join(h.dir, 'plans')).some((n) => n.startsWith('snap-')), 'no half export left behind');
  assertNoSecret(h, [job.events]);
});

test('environment values follow scoped attribute rules: only the matching form asks for a value', async (t) => {
  const h = await harness(t);
  const put = await h.call('PUT', `${P}/config`, { envBoundAttributes: { form: [{ name: 'Owner', kapp: 'services', form: 'leave' }, { name: 'Region', kapp: 'services' }] } });
  assert.equal(put.status, 200);
  for (const env of ['dev', 'test']) assert.equal((await h.job('POST', `${P}/snapshots`, { env })).status, 'succeeded');
  const p = await plan(h, { to: 'test', from: 'dev', selected: [FORM, CONN, OP] });
  const labels = p.environmentValues.filter((v) => v.key === FORM).map((v) => v.label);
  assert.ok(labels.includes('Region'), JSON.stringify(labels));
  assert.equal(labels.includes('Owner'), false);
});

test('environment values offer (never apply) the source value of a kept space setting the target has none for, pairs whole, and honour overrides and the list', async (t) => {
  const h = await harness(t);
  const withSpace = (original: () => Record<string, unknown>, extra: Record<string, unknown>) => () => {
    const routes = original();
    const space = (routes['GET core/space'] as { space: Record<string, unknown> }).space;
    return { ...routes, 'GET core/space': { space: { ...space, ...extra } } };
  };
  h.spaces.dev = withSpace(h.spaces.dev, {
    displayType: 'Custom', displayValue: 'https://dev.example.com/app', defaultLocale: 'fr', trustedFrameDomains: ['localhost:3000'], allowedIps: '10.0.0.0/8', allowedIpsEnabled: true, bundlePath: 'dev-bundle',
  });
  h.spaces.test = withSpace(h.spaces.test, { displayValue: null, defaultLocale: 'en', trustedFrameDomains: ['test.example.com'], allowedIpsEnabled: false, bundlePath: '' });
  for (const env of ['dev', 'test']) assert.equal((await h.job('POST', `${P}/snapshots`, { env })).status, 'succeeded');
  const result = async () => plan(h, { to: 'test', from: 'dev', selected: ['space'] });
  const rows = (p: PlanResult) => p.environmentValues.filter((v) => v.key === 'space' && !['name', 'slug', 'bundlePath'].includes(v.label))
    .map((v) => [v.label, v.origin, v.from, v.to, v.suggested, v.pair]);

  const first = await result();
  assert.deepEqual(rows(first), [
    // The display pair: Test has a type but no value, so the pair is offered whole.
    ['displayType', 'environment', 'Custom', 'Display Page', 'Custom', 'displayType+displayValue'],
    ['displayValue', 'environment', 'https://dev.example.com/app', null, 'https://dev.example.com/app', 'displayType+displayValue'],
    // Test has its own list: kept, nothing offered.
    ['trustedFrameDomains', 'environment', ['localhost:3000'], ['test.example.com'], undefined, undefined],
    ['allowedIps', 'environment', '10.0.0.0/8', null, '10.0.0.0/8', 'allowedIps+allowedIpsEnabled'],
    ['allowedIpsEnabled', 'environment', true, false, true, 'allowedIps+allowedIpsEnabled'],
  ]);
  // Nothing is copied unless chosen: the plan keeps Test's values.
  assert.deepEqual(first.items.find((i) => i.key === 'space')!.diff.map((d) => d.path), ['defaultLocale']);
  // Fixed fields (an empty bundlePath here) are kept as always, with nothing offered.
  const bundle = first.environmentValues.find((v) => v.label === 'bundlePath')!;
  assert.deepEqual([bundle.to, 'suggested' in bundle], ['', false]);

  // An override is listed as such, once.
  assert.equal((await h.call('PUT', `${P}/overrides/test`, { artifacts: { space: { displayValue: 'https://cdn.example.com/test' } }, replace: [] })).status, 200);
  assert.deepEqual((await result()).environmentValues.filter((v) => v.label === 'displayValue').map((v) => [v.origin, v.to]), [['override', 'https://cdn.example.com/test']]);
  assert.equal((await h.call('PUT', `${P}/overrides/test`, { artifacts: {}, replace: [] })).status, 200);
  // Unticked: promoted like any other setting, no longer offered.
  assert.equal((await h.call('PUT', `${P}/config`, { envBoundSpaceFields: ['defaultLocale'] })).status, 200);
  const unticked = await result();
  assert.equal(unticked.environmentValues.some((v) => v.label === 'displayValue'), false);
  assert.deepEqual(rows(unticked).find(([label]) => label === 'defaultLocale'), ['defaultLocale', 'environment', 'fr', 'en', undefined, undefined]);
});
