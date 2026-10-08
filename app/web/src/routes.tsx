// Routes: the projects launcher, the first-run wizard and the project frame
// with its tabs. Screens built in later tasks start as placeholders. Toasts
// that are not errors are cleared when the screen changes.
import { Navigate, Route, Routes } from 'react-router';
import { ProjectsPage } from './pages/ProjectsPage';
import { NewProjectWizard } from './pages/NewProjectWizard';
import { ProjectLayout } from './pages/ProjectLayout';
import { OverviewPage } from './pages/OverviewPage';
import { ExploreIndex } from './pages/Placeholder';
import { ExplorePage } from './pages/ExplorePage';
import { ComparePage } from './pages/ComparePage';
import { ChangesetDetailPage, ChangesetsPage } from './pages/ChangesetsPage';
import { PlanPage } from './pages/PlanPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsLayout } from './pages/settings/SettingsLayout';
import { EnvironmentsSettings } from './pages/settings/EnvironmentsSettings';
import { DataSettings } from './pages/settings/DataSettings';
import { RepositorySettings } from './pages/settings/RepositorySettings';
import { NotFoundPage } from './pages/NotFoundPage';
import { ToastRouteReset } from './components/ui/Toast';

export function AppRoutes() {
  return (
    <>
      <ToastRouteReset />
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/new" element={<NewProjectWizard />} />
        <Route path="/p/:projectId" element={<ProjectLayout />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="explore" element={<ExploreIndex />} />
          <Route path="explore/:env/*" element={<ExplorePage />} />
          <Route path="compare" element={<ComparePage />} />
          <Route path="changesets" element={<ChangesetsPage />} />
          <Route path="changesets/:changesetId" element={<ChangesetDetailPage />} />
          <Route path="plan/:planId" element={<PlanPage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="environments" replace />} />
            <Route path="environments" element={<EnvironmentsSettings />} />
            <Route path="data" element={<DataSettings />} />
            <Route path="repository" element={<RepositorySettings />} />
          </Route>
          <Route path="*" element={<NotFoundPage inProject />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  );
}
