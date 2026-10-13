import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/ui';
import { AuditPage } from './pages/Audit';
import { DeviceDetail } from './pages/DeviceDetail';
import { DevicesPage } from './pages/Devices';
import { LoginPage } from './pages/Login';
import { RejectedPage } from './pages/Rejected';
import { SettingsPage } from './pages/Settings';
import { ApiKeysPage } from './pages/ApiKeys';
import { ChannelLayout } from './pages/Channel';
import { DashboardPage } from './pages/Dashboard';
import { SetupPage } from './pages/Setup';
import { TeamPage } from './pages/Team';
import { AlertDetailPage, AlertsPage } from './pages/Alerts';
import { CommandTypesPage } from './pages/Commands';
import { FirmwarePage } from './pages/Firmware';
import { IntegrationsPage } from './pages/Integrations';
import { LabPage } from './pages/Lab';
import { OverviewPage } from './pages/Overview';
import { RulesPage } from './pages/Rules';
import { UsagePage } from './pages/Usage';
import { PlatformPage } from './pages/Platform';
import { SessionProvider, useSession } from './session';
import './styles.css';

/** Sends a signed-in user to their first project, or to setup if they have none. */
function Home() {
  const { orgs, refreshProjects } = useSession();
  const nav = useNavigate();
  const [needsSetup, setNeedsSetup] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      let lastOrg: string | null = null;
      try {
        lastOrg = localStorage.getItem('arc.lastProject');
      } catch {
        /* ignore */
      }
      for (const org of orgs) {
        const ps = await refreshProjects(org.id);
        const remembered = ps.find((p) => p.id === lastOrg);
        const target = remembered ?? ps[0];
        if (target && alive) return nav(`/o/${org.id}/p/${target.id}`, { replace: true });
      }
      if (alive) setNeedsSetup(true);
    })().catch(() => alive && setNeedsSetup(true));
    return () => {
      alive = false;
    };
  }, [orgs, nav, refreshProjects]);
  return needsSetup ? <Navigate to="/setup" replace /> : null;
}

function Gate() {
  const { user, loading } = useSession();
  if (loading) return null;
  if (!user) return <LoginPage />;
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/o/:orgId" element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="p/:projectId" element={<ChannelLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="devices" element={<DevicesPage />} />
          <Route path="devices/:deviceId" element={<DeviceDetail />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="api" element={<ApiKeysPage />} />
          <Route path="rules" element={<RulesPage />} />
          <Route path="commands" element={<CommandTypesPage />} />
        </Route>
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="alerts/:alertId" element={<AlertDetailPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="firmware" element={<FirmwarePage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="platform" element={<PlatformPage />} />
        <Route path="team" element={<TeamPage />} />
        <Route path="rejected" element={<RejectedPage />} />
        <Route path="audit" element={<AuditPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <SessionProvider>
          <Routes>
            <Route path="/lab" element={<LabPage />} />
            <Route path="*" element={<Gate />} />
          </Routes>
        </SessionProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
