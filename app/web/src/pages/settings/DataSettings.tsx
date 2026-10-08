// Settings → Data & values: attributes whose values belong to each
// environment (never promoted) and the reference data copied with the
// configuration. Pickers list names from the latest snapshot (the catalog);
// without one they fall back to typing.
import { useCatalog, useConfig } from '../../api/queries';
import { ErrorState, LoadingState } from '../../components/ui/EmptyState';
import { useProjectContext } from '../../lib/project';
import { AttributeRulesCard } from './AttributeRulesCard';
import { ReferenceDataCard } from './ReferenceDataCard';

export function DataSettings() {
  const { project } = useProjectContext();
  const config = useConfig(project.id);
  const catalog = useCatalog(project.id);
  if (config.isPending || catalog.isPending) return <LoadingState label="Loading settings…" />;
  if (config.isError) return <ErrorState title="Could not load the project settings" error={config.error} onRetry={() => config.refetch()} />;
  // An unreadable catalog only means no lists to pick from.
  const names = catalog.isError ? null : catalog.data;
  return (
    <div className="space-y-6">
      <AttributeRulesCard projectId={project.id} config={config.data} catalog={names} />
      <ReferenceDataCard projectId={project.id} config={config.data} catalog={names} />
    </div>
  );
}
