// The frame around every project screen: loads the project and its history,
// works out the active environment and hands both to the screens.
import { useEffect, useMemo } from 'react';
import { Outlet, useParams } from 'react-router';
import { FolderX } from 'lucide-react';
import { useHistory, useProject } from '../api/queries';
import { AppFrame } from '../components/AppFrame';
import { PlainFrame } from '../components/Brand';
import { EmptyState, ErrorState, LoadingState } from '../components/ui/EmptyState';
import { LinkButton } from '../components/ui/Button';
import { ApiError } from '../api/client';
import { driftByEnv, rememberProject, useActiveEnv, type ProjectContext } from '../lib/project';

export function ProjectLayout() {
  const { projectId = '' } = useParams();
  const project = useProject(projectId);
  const history = useHistory(projectId);
  const activeEnv = useActiveEnv(project.data);
  const events = useMemo(() => history.data ?? [], [history.data]);
  const drift = useMemo(() => driftByEnv(events), [events]);

  useEffect(() => {
    if (project.data) rememberProject(project.data.id);
  }, [project.data]);

  if (project.isPending) return <PlainFrame><LoadingState label="Opening project…" /></PlainFrame>;
  if (project.isError) {
    if (project.error instanceof ApiError && project.error.status === 404) {
      return (
        <PlainFrame>
          <EmptyState icon={<FolderX size={20} />} title="Project not found" description="It may have been moved or removed from the workspace." action={<LinkButton to="/" variant="primary">All projects</LinkButton>} />
        </PlainFrame>
      );
    }
    return <PlainFrame><ErrorState title="Could not open the project" error={project.error} onRetry={() => project.refetch()} /></PlainFrame>;
  }

  const ctx: ProjectContext = { project: project.data, history: events, activeEnv };
  return (
    <AppFrame project={project.data} activeEnv={activeEnv} drift={drift}>
      <Outlet context={ctx} />
    </AppFrame>
  );
}
