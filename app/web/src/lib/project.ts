// Project context for screens inside the project frame, the active
// environment (from the URL) and derived per-environment facts.
import { useLocation, useOutletContext, useParams, useSearchParams } from 'react-router';
import type { ProjectDetail } from '../../../shared/api';
import type { HistoryEvent, HistoryType } from '../../../shared/sync-api';

export interface ProjectContext {
  project: ProjectDetail;
  history: HistoryEvent[];
  activeEnv: string | null;
}

export const useProjectContext = () => useOutletContext<ProjectContext>();

const LAST_PROJECT = 'km-last-project';

export function rememberProject(id: string): void {
  try {
    localStorage.setItem(LAST_PROJECT, id);
  } catch {
    // Not essential.
  }
}

export function lastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
}

// The active environment: Explore's path segment, else `?env=`, else the
// first environment in the pipeline.
export function useActiveEnv(project: ProjectDetail | undefined): string | null {
  const { projectId } = useParams();
  const { pathname } = useLocation();
  const [search] = useSearchParams();
  const names = project?.environments.map((e) => e.name) ?? [];
  const explore = projectId ? pathname.match(new RegExp(`^/p/${projectId}/explore/([^/]+)`)) : null;
  const wanted = explore ? decodeURIComponent(explore[1]) : search.get('env');
  if (wanted && names.includes(wanted)) return wanted;
  return names[0] ?? null;
}

const byNewest = (a: HistoryEvent, b: HistoryEvent) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

// The newest history event of a type for each environment.
export function latestByEnv(history: HistoryEvent[], type: HistoryType): Record<string, HistoryEvent> {
  const out: Record<string, HistoryEvent> = {};
  for (const e of [...history].sort(byNewest)) {
    if (e.type === type && e.env && !out[e.env]) out[e.env] = e;
  }
  return out;
}

// Items drifted per environment, from each environment's newest snapshot.
export function driftByEnv(history: HistoryEvent[]): Record<string, number> {
  return Object.fromEntries(Object.entries(latestByEnv(history, 'snapshot')).map(([env, e]) => [env, e.drifted.length]));
}

export const newestFirst = (history: HistoryEvent[]): HistoryEvent[] => [...history].sort(byNewest);
