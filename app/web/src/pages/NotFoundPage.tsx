// Unknown routes.
import { MapPinOff } from 'lucide-react';
import { EmptyState } from '../components/ui/EmptyState';
import { LinkButton } from '../components/ui/Button';
import { PlainFrame } from '../components/Brand';

export function NotFoundPage({ inProject }: { inProject?: boolean }) {
  const body = (
    <EmptyState
      icon={<MapPinOff size={20} />}
      title="Page not found"
      description="This address doesn’t match anything in kinetic-migrate."
      action={<LinkButton to={inProject ? 'overview' : '/'} variant="primary">{inProject ? 'Back to overview' : 'All projects'}</LinkButton>}
    />
  );
  return inProject ? <div className="mx-auto max-w-5xl px-6 py-10">{body}</div> : <PlainFrame>{body}</PlainFrame>;
}
