import { useCallback, useEffect, useState } from "react";
import {
  Activity, AlertTriangle, ArrowUpRight, Check, Clock3, Database, Fingerprint, Radio,
  RefreshCw, Shield, Smartphone, Users, X,
} from "lucide-react";
import { api } from "./api";

type AdminTab = "overview" | "accounts" | "devices" | "sharing" | "security" | "reports";
type Overview = {
  users: { total: number; disabled: number };
  devices: { total: number; online: number };
  shares: { active: number };
  reports: { open: number };
  securityEvents24h: number;
  database: { healthy: boolean; checkedAt: string };
  uptimeSeconds: number;
  apiUsage: { route: string; requests: number }[];
};

export default function AdminPanel() {
  const [tab, setTab] = useState<AdminTab>("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [devices, setDevices] = useState<any[]>([]);
  const [sharing, setSharing] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [reports, setReports] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [working, setWorking] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError("");
    const result = await api<Overview>("/api/admin/overview");
    setOverview(result);
    if (tab === "accounts") setUsers((await api<{ users: any[] }>("/api/admin/users")).users);
    if (tab === "devices") setDevices((await api<{ devices: any[] }>("/api/admin/devices")).devices);
    if (tab === "sharing") setSharing((await api<{ shares: any[] }>("/api/admin/sharing")).shares);
    if (tab === "security") setEvents((await api<{ events: any[] }>("/api/admin/audit")).events);
    if (tab === "reports") setReports((await api<{ reports: any[] }>("/api/admin/reports")).reports);
  }, [tab]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    load().catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Admin information could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load]);

  async function setAccountStatus(id: string, disabled: boolean) {
    setWorking(id); setError("");
    try {
      await api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ disabled }) });
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Account status could not be changed."); }
    finally { setWorking(""); }
  }

  async function revokeShare(id: string) {
    if (!window.confirm("Revoke this active location-sharing session? This will not display or delete its location data.")) return;
    setWorking(id); setError("");
    try { await api(`/api/admin/sharing/${id}/revoke`, { method: "POST", body: "{}" }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Sharing session could not be revoked."); }
    finally { setWorking(""); }
  }

  async function updateReport(id: string, status: string) {
    setWorking(id); setError("");
    try { await api(`/api/admin/reports/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Report could not be updated."); }
    finally { setWorking(""); }
  }

  const tabs: { id: AdminTab; label: string; icon: React.ReactNode }[] = [
    { id: "overview", label: "Overview", icon: <Activity size={15} /> },
    { id: "accounts", label: "Accounts", icon: <Users size={15} /> },
    { id: "devices", label: "Devices", icon: <Smartphone size={15} /> },
    { id: "sharing", label: "Sharing", icon: <Radio size={15} /> },
    { id: "security", label: "Audit log", icon: <Shield size={15} /> },
    { id: "reports", label: "Abuse reports", icon: <AlertTriangle size={15} /> },
  ];

  return <div className="section-content admin-content">
    <div className="admin-privacy-banner"><Shield size={16} /><span><strong>Privacy boundary:</strong> administrator tools do not return coordinates, location histories, or map data. Account owners control precise location access.</span></div>
    <div className="admin-tabs">{tabs.map((item) => <button key={item.id} className={`admin-tab ${tab === item.id ? "admin-tab-active" : ""}`} onClick={() => setTab(item.id)}>{item.icon}{item.label}{item.id === "reports" && overview?.reports.open ? <span>{overview.reports.open}</span> : null}</button>)}<button className="icon-button admin-refresh" aria-label="Refresh" onClick={() => void load().catch((reason) => setError(reason.message))}><RefreshCw size={15} /></button></div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {loading && <div className="admin-loading"><span className="loader-orbit" />Loading platform overview…</div>}
    {!loading && tab === "overview" && overview && <>
      <div className="metrics-grid admin-metrics">
        <AdminMetric icon={<Users size={16} />} label="ACCOUNTS" value={overview.users.total} detail={`${overview.users.disabled} suspended`} />
        <AdminMetric icon={<Smartphone size={16} />} label="REGISTERED DEVICES" value={overview.devices.total} detail={`${overview.devices.online} seen in last 90 sec`} />
        <AdminMetric icon={<Radio size={16} />} label="ACTIVE SHARING" value={overview.shares.active} detail="Permissioned sessions" />
        <AdminMetric icon={<AlertTriangle size={16} />} label="OPEN REPORTS" value={overview.reports.open} detail="Awaiting review" />
      </div>
      <div className="two-column-grid">
        <section className="card section-card">
          <div className="card-heading"><div><span className="section-kicker">SERVICE HEALTH</span><h2>Platform status</h2></div><span className={`health-tag ${overview.database.healthy ? "healthy-tag" : "warning-tag"}`}><i />{overview.database.healthy ? "OPERATIONAL" : "CHECK DATABASE"}</span></div>
          <div className="health-grid"><div><span>DATABASE</span><strong><Database size={15} />{overview.database.healthy ? "Connected" : "Unavailable"}</strong></div><div><span>PROCESS UPTIME</span><strong><Clock3 size={15} />{formatUptime(overview.uptimeSeconds)}</strong></div><div><span>SECURITY EVENTS · 24H</span><strong><Shield size={15} />{overview.securityEvents24h}</strong></div><div><span>HEALTH CHECK</span><strong>{new Date(overview.database.checkedAt).toLocaleTimeString()}</strong></div></div>
        </section>
        <section className="card section-card">
          <div className="card-heading"><div><span className="section-kicker">API ACTIVITY</span><h2>Requests by route</h2></div><span className="soft-icon soft-blue"><Activity size={16} /></span></div>
          {overview.apiUsage.length ? <div className="usage-list">{overview.apiUsage.map((item) => <div key={item.route} className="usage-row"><span>{item.route}</span><strong>{item.requests}</strong><div className="usage-track"><i style={{ width: `${Math.max(5, Math.min(100, item.requests / Math.max(...overview.apiUsage.map((row) => row.requests)) * 100))}%` }} /></div></div>)}</div> : <div className="empty-inline"><Activity size={16} /><span>No API requests recorded in this process yet.</span></div>}
          <p className="card-footnote"><Activity size={12} />In-memory counters reset when the server restarts.</p>
        </section>
      </div>
    </>}
    {!loading && tab === "accounts" && <section className="card section-card admin-table-card"><div className="card-heading"><div><span className="section-kicker">ACCOUNT MANAGEMENT</span><h2>User accounts</h2></div><span className="count-pill">{users.length} shown</span></div><div className="admin-table"><div className="admin-table-head accounts-cols"><span>ACCOUNT</span><span>ROLE</span><span>DEVICES</span><span>ACTIVE SHARES</span><span>STATUS / ACTION</span></div>{users.map((account) => <div className="admin-table-row accounts-cols" key={account.id}><div className="admin-account-cell"><span className="admin-avatar">{account.display_name?.charAt(0)?.toUpperCase() ?? <Fingerprint size={15} />}</span><span><strong>{account.display_name}</strong><small>{account.email}</small></span></div><span className="role-pill">{account.role}</span><span>{account.device_count}</span><span>{account.active_shares}</span><span>{account.disabled_at ? <button className="button button-subtle button-compact" onClick={() => void setAccountStatus(account.id, false)} disabled={working === account.id}><Check size={12} />Restore</button> : <button className="button button-danger-outline button-compact" onClick={() => void setAccountStatus(account.id, true)} disabled={working === account.id}><X size={12} />Suspend</button>}</span></div>)}</div><p className="card-footnote"><AlertTriangle size={12} />Suspending an account immediately revokes its active sharing and ends its sign-in sessions.</p></section>}
    {!loading && tab === "devices" && <section className="card section-card admin-table-card"><div className="card-heading"><div><span className="section-kicker">DEVICE INVENTORY</span><h2>Registered devices</h2></div><span className="count-pill">{devices.length} shown</span></div><div className="admin-table"><div className="admin-table-head device-cols"><span>DEVICE</span><span>ACCOUNT</span><span>TYPE / PLATFORM</span><span>LAST SEEN</span><span>SHARES</span></div>{devices.map((device) => <div className="admin-table-row device-cols" key={device.id}><div className="admin-account-cell"><span className={`device-row-icon small-device-icon ${device.online ? "device-row-online" : ""}`}><Smartphone size={15} /></span><span><strong>{device.display_name}</strong><small>{device.browser}</small></span></div><span>{device.owner_email}</span><span>{device.device_type} · {device.operating_system}</span><span><i className={`mini-dot ${device.online ? "green-dot" : ""}`} />{relativeAdmin(device.last_seen)}</span><span>{device.active_shares}</span></div>)}</div><p className="card-footnote"><Shield size={12} />Only user-authorized device metadata is shown. No location data is available here.</p></section>}
    {!loading && tab === "sharing" && <section className="card section-card admin-table-card"><div className="card-heading"><div><span className="section-kicker">CONSENT OPERATIONS</span><h2>Location-sharing sessions</h2></div><span className="count-pill">{sharing.filter((item) => !item.stopped_at).length} active</span></div><div className="admin-table"><div className="admin-table-head sharing-cols"><span>DEVICE OWNER</span><span>DEVICE</span><span>AUTHORIZED VIEWER</span><span>STATUS / STARTED</span><span>ACTION</span></div>{sharing.map((item) => <div className="admin-table-row sharing-cols" key={item.id}><span>{item.owner_email}</span><span><strong>{item.device_name}</strong><small>{item.device_type}</small></span><span>{item.viewer_email}</span><span><span className={`invite-state ${item.stopped_at ? "invite-closed" : "invite-pending"}`} />{item.stopped_at ? `${item.stop_reason ?? "Stopped"} · ${relativeAdmin(item.started_at)}` : `Active · ${relativeAdmin(item.started_at)}`}</span><span>{!item.stopped_at && <button className="button button-danger-outline button-compact" onClick={() => void revokeShare(item.id)} disabled={working === item.id}><X size={12} />Revoke</button>}</span></div>)}</div><p className="card-footnote"><Shield size={12} />Administrators can revoke access but cannot view precise locations or location histories.</p></section>}
    {!loading && tab === "security" && <section className="card section-card admin-table-card"><div className="card-heading"><div><span className="section-kicker">SECURITY & ACCESS EVENTS</span><h2>Audit log</h2></div><span className="count-pill">{events.length} recent</span></div>{events.length ? <div className="admin-audit-list">{events.map((event) => <div key={event.id} className="admin-audit-row"><span className="admin-audit-mark"><Shield size={13} /></span><div><strong>{eventLabel(event.event_type)}</strong><span>{event.actor_email ?? "Account removed"}{event.device_name ? ` · ${event.device_name}` : ""}</span></div><time>{new Date(event.created_at).toLocaleString()}</time></div>)}</div> : <div className="empty-inline"><Shield size={17} /><span>No security events recorded.</span></div>}<p className="card-footnote"><LockKeyhole size={12} />Audit metadata excludes coordinates and location point contents.</p></section>}
    {!loading && tab === "reports" && <section className="card section-card admin-table-card"><div className="card-heading"><div><span className="section-kicker">TRUST & SAFETY</span><h2>Abuse reports</h2></div><span className="count-pill">{reports.filter((item) => item.status === "open").length} open</span></div>{reports.length ? <div className="report-admin-list">{reports.map((report) => <div className="report-admin-card" key={report.id}><div className="report-admin-top"><span className="role-pill">{report.category.replaceAll("_", " ")}</span><span className={`health-tag ${report.status === "open" ? "warning-tag" : "healthy-tag"}`}>{report.status.toUpperCase()}</span><span className="report-admin-date">{new Date(report.created_at).toLocaleString()}</span></div><p>{report.details}</p><span className="report-admin-by">Reported by {report.reporter_email}</span><div className="report-admin-actions"><button className="button button-subtle button-compact" onClick={() => void updateReport(report.id, "reviewing")} disabled={working === report.id}>Mark reviewing</button><button className="button button-outline button-compact" onClick={() => void updateReport(report.id, "resolved")} disabled={working === report.id}><Check size={12} />Resolve</button><button className="button button-quiet button-compact" onClick={() => void updateReport(report.id, "dismissed")} disabled={working === report.id}>Dismiss</button></div></div>)}</div> : <div className="empty-inline"><Check size={17} /><span>No abuse reports have been submitted.</span></div>}</section>}
  </div>;
}

function AdminMetric({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: number; detail: string }) {
  return <div className="card metric-card"><div className="metric-icon metric-blue">{icon}</div><span className="section-kicker">{label}</span><strong className="metric-value">{value}</strong><span className="metric-detail">{detail}</span></div>;
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return days ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
}

function relativeAdmin(value?: string | null) {
  return value ? `${Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000))}m ago` : "Never";
}

function eventLabel(event: string) {
  return event.replaceAll("_", " ").replace(/\b\w/g, (char: string) => char.toUpperCase());
}
