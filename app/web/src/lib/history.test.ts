// History rules: how each event type reads, grouping by day, filters, and
// where Restore… and Open in Compare lead.
import { expect, test } from 'vitest';
import type { RunRecord } from '../../../shared/sync-api';
import { historyEvent } from '../test/fixtures';
import {
  acknowledgementText, compareHrefFor, eventInfo, fallbackName, filterEvents, groupByDay, isDefaultAuthor, restoreTargetFor, runCounts, runDuration, valuePathLabel,
} from './history';

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: 'r1', kind: 'apply', name: 'Q4 forms', planId: 'pl1', changesetId: null, from: 'dev', to: 'test',
  source: { commit: 'c-src', path: 'snapshots/dev' }, backupCommit: 'c-backup',
  startedAt: '2026-10-08T10:00:00Z', finishedAt: '2026-10-08T10:01:05Z', status: 'applied',
  selection: ['teams/Ops', 'kapps/hr/forms/leave/form', 'kapps/hr/forms/travel/form'], acknowledgements: ['drift:teams/Ops'], resolutions: {},
  values: {}, secretsUsed: [], items: [
    { key: 'teams/Ops', status: 'done' }, { key: 'kapps/hr/forms/leave/form', status: 'done' }, { key: 'kapps/hr/forms/travel/form', status: 'failed', message: 'boom' },
  ], done: 2, error: null, ...over,
});

test('every event type reads as plain words with a non-colour signal', () => {
  const cases: Array<[Parameters<typeof historyEvent>[0], string]> = [
    [{ type: 'snapshot' }, 'Snapshot'],
    [{ type: 'backup' }, 'Backup'],
    [{ type: 'changeset' }, 'Changeset saved'],
    [{ type: 'applied', status: 'applied' }, 'Applied'],
    [{ type: 'applied', status: 'partial' }, 'Partly applied'],
    [{ type: 'applied', status: 'failed' }, 'Failed'],
    [{ type: 'applied', status: 'cancelled' }, 'Stopped'],
    [{ type: 'restore', status: 'applied' }, 'Restored'],
    [{ type: 'restore', status: 'partial' }, 'Partly restored'],
    [{ type: 'drift', drifted: ['a', 'b'] }, 'Drift detected'],
    [{ type: 'project' }, 'Project'],
  ];
  for (const [over, label] of cases) {
    const info = eventInfo(historyEvent(over));
    expect(info.label).toBe(label);
    expect(info.symbol).toBeTruthy();
  }
  expect(eventInfo(historyEvent({ type: 'applied', status: 'failed' })).tone).toBe('danger');
  expect(eventInfo(historyEvent({ type: 'drift' })).tone).toBe('drift');
});

test('groups newest first by local day, with Today and Yesterday', () => {
  const now = new Date(2026, 9, 8, 15, 0);
  const at = (d: number, h: number) => new Date(2026, 9, d, h, 0).toISOString();
  const groups = groupByDay([
    historyEvent({ id: 'a', at: at(6, 9) }),
    historyEvent({ id: 'b', at: at(8, 9) }),
    historyEvent({ id: 'c', at: at(7, 9) }),
    historyEvent({ id: 'd', at: at(8, 14) }),
  ], now);
  expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Oct 6, 2026']);
  expect(groups[0].events.map((e) => e.id)).toEqual(['d', 'b']);
});

test('filters by environment and type; "applied" includes partial and failed runs', () => {
  const events = [
    historyEvent({ id: '1', env: 'dev', type: 'snapshot' }),
    historyEvent({ id: '2', env: 'test', type: 'applied', status: 'failed' }),
    historyEvent({ id: '3', env: 'test', type: 'backup' }),
    historyEvent({ id: '4', env: null, type: 'project' }),
  ];
  expect(filterEvents(events, { env: 'test', type: null }).map((e) => e.id)).toEqual(['2', '3']);
  expect(filterEvents(events, { env: null, type: 'applied' }).map((e) => e.id)).toEqual(['2']);
  expect(filterEvents(events, { env: null, type: null })).toHaveLength(4);
});

test('restore targets: a backup or snapshot itself, or the backup an apply took', () => {
  expect(restoreTargetFor(historyEvent({ type: 'backup', commit: 'c-b', env: 'test' }), null)).toEqual({ commit: 'c-b', env: 'test' });
  expect(restoreTargetFor(historyEvent({ type: 'snapshot', commit: 'c-s', env: 'dev' }), null)).toEqual({ commit: 'c-s', env: 'dev' });
  expect(restoreTargetFor(historyEvent({ type: 'applied', commit: 'c-a', env: 'test' }), run())).toEqual({ commit: 'c-backup', env: 'test' });
  expect(restoreTargetFor(historyEvent({ type: 'applied', commit: 'c-a', env: 'test' }), run({ backupCommit: null }))).toBeNull();
  expect(restoreTargetFor(historyEvent({ type: 'changeset', env: 'dev' }), null)).toBeNull();
});

test('open in compare: the run’s environments, else the event’s environment', () => {
  expect(compareHrefFor('p1', historyEvent({ type: 'applied', env: 'test' }), run())).toBe('/p/p1/compare?from=dev&to=test');
  expect(compareHrefFor('p1', historyEvent({ type: 'drift', env: 'test' }), null)).toBe('/p/p1/compare?to=test');
  expect(compareHrefFor('p1', historyEvent({ type: 'snapshot', env: 'dev' }), null)).toBe('/p/p1/compare?from=dev');
  expect(compareHrefFor('p1', historyEvent({ type: 'project', env: null }), null)).toBeNull();
});

test('run counts and duration', () => {
  expect(runCounts(run())).toEqual({ selected: 3, done: 2, failed: 1, skipped: 0 });
  expect(runDuration(run())).toBe('1m 5s');
  expect(runDuration(run({ finishedAt: '2026-10-08T10:00:12Z' }))).toBe('12s');
});

test('acknowledgements and environment values read as words', () => {
  const labels: Record<string, string> = { 'kapps/services/forms/it-request/form': 'IT Request' };
  const labelOf = (k: string) => labels[k] ?? fallbackName(k);
  expect(acknowledgementText('handler:handlers/mail_send_v1/handler', 'test', labelOf)).toBe('Install handler Mail Send');
  expect(acknowledgementText('connection-secrets:connections/Ticketing/connection', 'test', labelOf)).toBe('Create connection Ticketing without credentials');
  expect(acknowledgementText('index:kapps/services/forms/it-request/form', 'test', labelOf)).toBe('Rebuild indexes on IT Request');
  expect(acknowledgementText('drift:teams/Ops', 'test', labelOf)).toBe('Overwrite changes made in Test to Ops');
  expect(acknowledgementText('something-else', 'test', labelOf)).toBe('something-else');
  expect(valuePathLabel('properties.Server.value')).toBe('Server');
  expect(valuePathLabel('properties.Mail\\.Host.value')).toBe('Mail.Host');
  expect(valuePathLabel('attributes.Web Server Url')).toBe('Web Server Url');
  expect(valuePathLabel('config.baseUrl')).toBe('Config › Base url');
  expect(isDefaultAuthor('kinetic-migrate')).toBe(true);
  expect(isDefaultAuthor('Pat Example')).toBe(false);
});

test('a run whose snapshot afterwards failed says so whatever its outcome', () => {
  const w = ['The snapshot of Test taken after the apply failed: x. Take a snapshot before comparing again.'];
  const ev = (type: 'applied' | 'restore', status: 'applied' | 'partial' | 'failed' | 'cancelled') => historyEvent({ type, status, warnings: w });
  expect(eventInfo(ev('applied', 'applied'))).toEqual({ label: 'Applied, snapshot failed', tone: 'drift', symbol: '!' });
  expect(eventInfo(ev('applied', 'partial'))).toEqual({ label: 'Partly applied, snapshot failed', tone: 'drift', symbol: '◐' });
  expect(eventInfo(ev('applied', 'failed'))).toEqual({ label: 'Failed, snapshot failed', tone: 'danger', symbol: '×' });
  expect(eventInfo(ev('applied', 'cancelled')).label).toBe('Stopped, snapshot failed');
  expect(eventInfo(ev('restore', 'partial')).label).toBe('Partly restored, snapshot failed');
  expect(eventInfo(historyEvent({ type: 'applied', status: 'applied' })).label).toBe('Applied');
});
