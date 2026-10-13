import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom';
import { api, Device, Field, Org, Project } from '../api';
import { usePoll } from '../components/ui';
import { useSession } from '../session';

export interface ChannelCtx {
  org?: Org;
  project?: Project;
  fields: Field[] | null;
  reloadFields: () => Promise<void>;
  devices: Device[] | null;
  reloadDevices: () => Promise<void>;
}

export const useChannel = () => useOutletContext<ChannelCtx>();

/** Wraps every channel page: title, tabs, and the channel's fields and devices. */
export function ChannelLayout() {
  const { orgId = '', projectId = '', deviceId } = useParams();
  const { org } = useOutletContext<{ org?: Org }>();
  const { projects } = useSession();
  const project = projects[orgId]?.find((p) => p.id === projectId);
  const [fields, setFields] = useState<Field[] | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);

  const reloadFields = useCallback(async () => {
    const r = await api<{ items: Field[] }>('GET', `/projects/${projectId}/fields`);
    setFields(r.items);
  }, [projectId]);
  const reloadDevices = useCallback(async () => {
    const r = await api<{ items: Device[] }>('GET', `/devices?projectId=${projectId}&limit=200`);
    setDevices(r.items);
  }, [projectId]);

  useEffect(() => {
    setFields(null);
    setDevices(null);
    void reloadFields().catch(() => setFields([]));
  }, [reloadFields]);
  // Keep device status (online/offline) fresh for the dashboard's device picker.
  usePoll(() => reloadDevices().catch(() => setDevices((d) => d ?? [])), 10_000, [reloadDevices]);

  const base = `/o/${orgId}/p/${projectId}`;
  const tab = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '');

  return (
    <>
      {!deviceId && (
        <div className="channel-head">
          <div>
            <h1>{project?.name ?? 'Channel'}</h1>
            {project?.description && <p className="sub">{project.description}</p>}
          </div>
          <nav className="channel-tabs" aria-label="Channel">
            <NavLink to={base} end className={tab}>
              Dashboard
            </NavLink>
            <NavLink to={`${base}/devices`} className={tab}>
              Devices
            </NavLink>
            <NavLink to={`${base}/rules`} className={tab}>
              Rules
            </NavLink>
            <NavLink to={`${base}/commands`} className={tab}>
              Commands
            </NavLink>
            <NavLink to={`${base}/settings`} className={tab}>
              Channel settings
            </NavLink>
            <NavLink to={`${base}/api`} className={tab}>
              API keys &amp; export
            </NavLink>
          </nav>
        </div>
      )}
      <Outlet context={{ org, project, fields, reloadFields, devices, reloadDevices } satisfies ChannelCtx} />
    </>
  );
}
