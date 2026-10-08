// Synthetic API fixtures for web tests (no real names or URLs).
import type { EnvironmentInfo, ProjectDetail } from '../../../shared/api';
import type { HistoryEvent } from '../../../shared/sync-api';

export const NOW = new Date('2026-10-08T12:00:00Z');

export const V6 = { version: '6.1.7', major: 6, minor: 1, source: 'integrator', detectedAt: '2026-10-08T10:00:00Z' };
export const V7 = { version: '7.0.0-rc3', major: 7, minor: 0, source: 'integrator', detectedAt: '2026-10-08T10:00:00Z' };

export function env(name: string, over: Partial<EnvironmentInfo> = {}): EnvironmentInfo {
  return {
    name,
    url: `https://${name}.your-space.kinops.io`,
    readOnly: false,
    credentials: { username: true, password: true },
    lastSnapshot: { commit: `c-${name}`, at: '2026-10-08T10:00:00Z', message: `Snapshot of ${name}` },
    ...over,
  };
}

export function project(over: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: 'acme-demo',
    name: 'Demo migration',
    path: '/workspace/acme-demo',
    environments: [env('dev'), env('test'), env('prod', { readOnly: true, lastSnapshot: null })],
    ...over,
  };
}

export function historyEvent(over: Partial<HistoryEvent>): HistoryEvent {
  return {
    id: 'h1', commit: 'abc', type: 'snapshot', title: 'Snapshot of Dev', at: '2026-10-08T10:00:00Z', author: 'Tester',
    env: 'dev', runId: null, changesetId: null, status: null, drifted: [], ...over,
  };
}
