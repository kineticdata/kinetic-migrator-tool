// Routes: the projects launcher, the first-run wizard and the project frame
// with its tabs. Screens built in later tasks start as placeholders.
import { Navigate, Route, Routes } from 'react-router';
import { ProjectsPage } from './pages/ProjectsPage';
import { NewProjectWizard } from './pages/NewProjectWizard';
import { ProjectLayout } from './pages/ProjectLayout';
import { OverviewPage } from './pages/OverviewPage';
import { ExploreIndex, Placeholder } from './pages/Placeholder';
import { SettingsLayout } from './pages/settings/SettingsLayout';
import { EnvironmentsSettings } from './pages/settings/EnvironmentsSettings';
import { DataSettings } from './pages/settings/DataSettings';
import { NotFoundPage } from './pages/NotFoundPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<ProjectsPage />} />
      <Route path="/new" element={<NewProjectWizard />} />
      <Route path="/p/:projectId" element={<ProjectLayout />}>
        <Route index element={<Navigate to="overview" replace />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="explore" element={<ExploreIndex />} />
        <Route path="explore/:env/*" element={<Placeholder screen="explore" />} />
        <Route path="compare" element={<Placeholder screen="compare" />} />
        <Route path="changesets" element={<Placeholder screen="changesets" />} />
        <Route path="changesets/:changesetId" element={<Placeholder screen="changesets" />} />
        <Route path="plan/:planId" element={<Placeholder screen="plan" />} />
        <Route path="history" element={<Placeholder screen="history" />} />
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="environments" replace />} />
          <Route path="environments" element={<EnvironmentsSettings />} />
          <Route path="data" element={<DataSettings />} />
        </Route>
        <Route path="*" element={<NotFoundPage inProject />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
