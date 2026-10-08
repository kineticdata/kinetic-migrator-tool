// Screens still to be built show a calm placeholder inside the frame.
import { Navigate } from 'react-router';
import { Compass, GitCompare, History, Layers, ListChecks } from 'lucide-react';
import { EmptyState } from '../components/ui/EmptyState';
import { useProjectContext } from '../lib/project';

const screens = {
  explore: { title: 'Explore', icon: <Compass size={20} />, text: 'Browse everything in an environment’s snapshot.' },
  compare: { title: 'Compare', icon: <GitCompare size={20} />, text: 'See what differs between two environments and pick what to promote.' },
  changesets: { title: 'Changesets', icon: <Layers size={20} />, text: 'Saved selections you can promote through each environment.' },
  plan: { title: 'Promote', icon: <ListChecks size={20} />, text: 'Review, fill in environment values, confirm and apply.' },
  history: { title: 'History', icon: <History size={20} />, text: 'Every snapshot, promotion and backup, in plain words.' },
} as const;

export function Placeholder({ screen }: { screen: keyof typeof screens }) {
  const s = screens[screen];
  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <EmptyState icon={s.icon} title={s.title} description={`${s.text} This screen is coming soon.`} />
    </div>
  );
}

// /explore without an environment opens the active one.
export function ExploreIndex() {
  const { project, activeEnv } = useProjectContext();
  return <Navigate to={activeEnv ? `/p/${project.id}/explore/${encodeURIComponent(activeEnv)}` : `/p/${project.id}/overview`} replace />;
}
