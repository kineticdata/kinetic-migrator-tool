// Add or edit an environment: URL, protected flag and write-only credentials,
// with Test connection (which saves first, since the server tests what is
// stored).
import { useState } from 'react';
import type { ConnectionTestResult, CredentialsStatus, EnvironmentInfo } from '../../../../shared/api';
import { testConnection, usePutCredentials, usePutEnvironment } from '../../api/queries';
import { ConnectionTestSteps } from '../../components/ConnectionTest';
import { EnvironmentFields, draftErrors, emptyDraft, type EnvironmentDraft } from '../../components/EnvironmentFields';
import { Button } from '../../components/ui/Button';
import { Dialog, DialogContent } from '../../components/ui/Dialog';
import { InlineError } from '../../components/ui/EmptyState';
import { useToast } from '../../components/ui/Toast';
import { envLabel } from '../../lib/format';

export function EnvironmentDialog({ projectId, environment, onClose }: {
  projectId: string;
  environment: EnvironmentInfo | null;
  onClose: () => void;
}) {
  const isNew = !environment;
  const [draft, setDraft] = useState<EnvironmentDraft>(environment
    ? { ...emptyDraft(environment.name), url: environment.url, readOnly: environment.readOnly }
    : emptyDraft());
  const [created, setCreated] = useState(!isNew);
  const [credentials, setCredentials] = useState<CredentialsStatus>(environment?.credentials ?? { username: false, password: false });
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const putEnv = usePutEnvironment(projectId);
  const putCreds = usePutCredentials(projectId);
  const toast = useToast();

  // Saves the environment and any typed credentials; clears the password.
  const save = async (): Promise<boolean> => {
    setShowErrors(true);
    setError(null);
    if (Object.keys(draftErrors(draft)).length) return false;
    await putEnv.mutateAsync({ env: draft.name, url: draft.url.trim(), readOnly: draft.readOnly });
    setCreated(true);
    const creds: { username?: string; password?: string } = {};
    if (draft.username) creds.username = draft.username;
    if (draft.password) creds.password = draft.password;
    if (Object.keys(creds).length) {
      setCredentials(await putCreds.mutateAsync({ env: draft.name, ...creds }));
      setDraft((d) => ({ ...d, username: '', password: '' }));
    }
    return true;
  };

  const run = async (kind: 'save' | 'test') => {
    setBusy(kind);
    try {
      if (!(await save())) return;
      if (kind === 'save') {
        toast.show({ tone: 'success', title: `${envLabel(draft.name)} saved` });
        onClose();
      } else {
        setResult(await testConnection(projectId, draft.name));
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="max-w-xl"
        title={isNew ? 'Add environment' : `Edit ${envLabel(draft.name)}`}
        description={isNew ? 'Connect a Kinetic space. New environments go at the end of the pipeline; reorder them in the list.' : 'Leave the username and password empty to keep the saved ones.'}
      >
        <EnvironmentFields draft={draft} onChange={(d) => { setDraft(d); setResult(null); }} nameLocked={created} credentials={credentials} showErrors={showErrors} />
        <div className="mt-5 space-y-3">
          {result && <ConnectionTestSteps result={result} />}
          <InlineError error={error} />
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={onClose}>{created && isNew ? 'Close' : 'Cancel'}</Button>
          <Button loading={busy === 'test'} disabled={busy !== null} onClick={() => run('test')}>Test connection</Button>
          <Button variant="primary" loading={busy === 'save'} disabled={busy !== null} onClick={() => run('save')}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
