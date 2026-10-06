import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Battery, Bell, Check, ChevronDown, ChevronRight,
  CircleHelp, Clock3, Copy, ExternalLink, Eye, FileText, Fingerprint, Gauge, Globe2, HardDrive,
  KeyRound, LockKeyhole, LogOut, MapPin, Menu, MoreHorizontal, Network, Plus, Radio, RefreshCw,
  Search, Settings2, Shield, ShieldAlert, ShieldCheck, Smartphone, Trash2, UserRound, Users, Wifi,
  X, Zap,
} from "lucide-react";
import { api, ApiError, type CurrentUser, type Device, type LocationPoint, type Share } from "./api";
import { collectDeviceInfo, getCurrentPosition, getStoredDeviceId, storeDeviceId, stopLocationWatch, watchApprovedDevice } from "./location-client";
import LocationMap, { formatTimeAgo } from "./LocationMap";
import AdminPanel from "./AdminPanel";

type Section = "overview" | "devices" | "privacy" | "settings" | "admin";
type Invitation = { id: string; target: string; created_at: string; expires_at: string; accepted_at: string | null; revoked_at: string | null; usable: boolean };
type AuditEvent = { id: string; event_type: string; created_at: string; metadata: Record<string, unknown>; related_to_sharing: boolean };
type HistoryPoint = LocationPoint & { recordedAt: string };

const relative = (value?: string | null) => value ? formatTimeAgo(new Date(value)) : "Not available";
const dateTime = (value?: string | null) => value ? new Date(value).toLocaleString() : "Not available";

export default function Dashboard({ user, onUserChange, onLogout }: {
  user: CurrentUser;
  onUserChange: (user: CurrentUser) => void;
  onLogout: () => void;
}) {
  const [section, setSection] = useState<Section>("overview");
  const [devices, setDevices] = useState<Device[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState("");
  const [inviteTarget, setInviteTarget] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [pairInput, setPairInput] = useState("");
  const [history, setHistory] = useState<Record<string, HistoryPoint[]>>({});
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);
  const [reportCategory, setReportCategory] = useState("unauthorized_access");
  const [reportDetails, setReportDetails] = useState("");
  const [reportSuccess, setReportSuccess] = useState(false);
  const [profileName, setProfileName] = useState(user.displayName);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const socket = useRef<Socket | null>(null);
  const currentDeviceId = getStoredDeviceId();

  const refreshData = useCallback(async () => {
    const [deviceData, shareData] = await Promise.all([
      api<{ devices: Device[] }>("/api/devices"),
      api<{ shares: Share[] }>("/api/shares"),
    ]);
    setDevices(deviceData.devices);
    setShares(shareData.shares);
    return { devices: deviceData.devices, shares: shareData.shares };
  }, []);

  const refreshInvitations = useCallback(async () => {
    const result = await api<{ invitations: Invitation[] }>("/api/invitations");
    setInvitations(result.invitations);
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const loaded = await refreshData();
        if (!active) return;
        if (section === "devices") await refreshInvitations();
        if (section === "privacy") {
          const result = await api<{ events: AuditEvent[] }>("/api/privacy/audit");
          if (active) setEvents(result.events);
        }
        const localId = getStoredDeviceId();
        const device = loaded.devices.find((item) => item.id === localId);
        const approvedShare = loaded.shares.find((item) => item.device_id === localId && item.owner_id === user.id && !item.stopped_at && !item.revoked_at);
        if (device && approvedShare && document.visibilityState === "visible") {
          watchApprovedDevice(device.id, setError);
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Dashboard data could not be loaded.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [refreshData, refreshInvitations, section, user.id]);

  useEffect(() => {
    const connection = io({ withCredentials: true });
    socket.current = connection;
    connection.on("location:update", (payload: { sessionId: string; point: LocationPoint & { recordedAt?: string } }) => {
      setShares((current) => current.map((share) => share.id === payload.sessionId ? {
        ...share,
        ...payload.point,
        recorded_at: payload.point.recordedAt ?? new Date().toISOString(),
        device_online: true,
        last_seen: new Date().toISOString(),
      } : share));
    });
    connection.on("sharing:revoked", () => { void refreshData().catch(() => undefined); });
    connection.on("admin:account-disabled", () => { onLogout(); });
    connection.on("connect_error", (reason) => {
      if (reason.message === "Authentication required.") onLogout();
    });
    return () => {
      connection.disconnect();
      socket.current = null;
    };
  }, [onLogout, refreshData]);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      const id = getStoredDeviceId();
      if (!id || document.visibilityState !== "visible") return;
      try {
        const device = devices.find((item) => item.id === id);
        const metadata = await collectDeviceInfo();
        await api(`/api/devices/${id}/heartbeat`, { method: "POST", body: JSON.stringify({
          ...metadata,
          displayName: device?.display_name ?? metadata.displayName,
        }) });
      } catch { /* The next visible heartbeat will refresh the status. */ }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [devices]);

  const activeShares = useMemo(() => shares.filter((share) => !share.stopped_at && !share.revoked_at), [shares]);
  const selectedShare = useMemo(() => {
    const withPoint = activeShares.find((share) => share.latitude != null && share.longitude != null)
      ?? shares.find((share) => share.owner_id === user.id && share.latitude != null && share.longitude != null)
      ?? shares.find((share) => share.latitude != null && share.longitude != null);
    return withPoint ?? null;
  }, [activeShares, shares, user.id]);
  const activeCount = activeShares.length;
  const liveCount = activeShares.filter((share) => share.device_online && share.latitude != null).length;
  const staleLocation = !!selectedShare && (!selectedShare.device_online || !selectedShare.recorded_at || Date.now() - new Date(selectedShare.recorded_at).getTime() > 60_000);

  async function registerCurrentDevice() {
    setWorking("register");
    setError(""); setMessage("");
    try {
      const metadata = await collectDeviceInfo();
      const result = await api<{ device: Device }>("/api/devices/register", {
        method: "POST",
        body: JSON.stringify({ ...metadata, deviceId: getStoredDeviceId() }),
      });
      storeDeviceId(result.device.id);
      setMessage("This browser is registered to your account.");
      await refreshData();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Device registration failed."); }
    finally { setWorking(""); }
  }

  async function beginOwnSharing() {
    setWorking("share");
    setError(""); setMessage("");
    try {
      if (!window.isSecureContext && location.hostname !== "localhost") throw new Error("Open Nexus over HTTPS to use browser location.");
      const point = await getCurrentPosition();
      const device = await collectDeviceInfo();
      const result = await api<{ share: { id: string; deviceId: string } }>("/api/shares/start", {
        method: "POST",
        body: JSON.stringify({ currentDevice: { deviceId: getStoredDeviceId(), device }, point }),
      });
      storeDeviceId(result.share.deviceId);
      watchApprovedDevice(result.share.deviceId, setError);
      setMessage("Location sharing is on for this device. You can stop it here at any time.");
      await refreshData();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        setError("This device is already sharing. Check the active sharing controls below.");
      } else setError(reason instanceof Error ? reason.message : "Location sharing could not be started.");
    } finally { setWorking(""); }
  }

  async function stopShare(share: Share) {
    setWorking(`stop-${share.id}`); setError(""); setMessage("");
    try {
      await api(`/api/shares/${share.id}/stop`, { method: "POST", body: "{}" });
      if (share.owner_id === user.id && share.device_id === getStoredDeviceId()) {
        const result = await refreshData();
        if (!result.shares.some((item) => item.device_id === share.device_id && item.owner_id === user.id && !item.stopped_at && !item.revoked_at)) {
          stopLocationWatch(share.device_id);
        }
      } else await refreshData();
      setMessage("Access has been revoked. This sharing session is closed.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Sharing could not be stopped."); }
    finally { setWorking(""); }
  }

  async function stopAllSharing() {
    if (!window.confirm("Stop all location-sharing sessions for your account now? Viewers will lose access immediately.")) return;
    setWorking("stop-all"); setError(""); setMessage("");
    try {
      await api("/api/privacy/stop-all", { method: "POST", body: "{}" });
      const id = getStoredDeviceId();
      if (id) stopLocationWatch(id);
      await refreshData();
      setMessage("All sharing sessions have been stopped and access revoked.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Sharing could not be stopped."); }
    finally { setWorking(""); }
  }

  async function createInvitation(event: React.FormEvent) {
    event.preventDefault();
    setWorking("invite"); setError(""); setMessage(""); setInviteLink("");
    try {
      const result = await api<{ invitation: { token: string } }>("/api/invitations", {
        method: "POST", body: JSON.stringify({ target: inviteTarget }),
      });
      const url = `${window.location.origin}/invite/${result.invitation.token}`;
      setInviteLink(url);
      setInviteTarget("");
      await refreshInvitations();
      setMessage("One-time invitation link created. Send it directly to the intended device owner.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Invitation could not be created."); }
    finally { setWorking(""); }
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage("Copied to clipboard.");
    } catch { setError("Clipboard access is unavailable in this browser. Select and copy the link manually."); }
  }

  async function shareInvite() {
    if (!inviteLink) return;
    if (navigator.share) {
      try { await navigator.share({ title: "Nexus Locator invitation", text: "Review this consent-based location sharing invitation.", url: inviteLink }); }
      catch (reason) { if (reason instanceof Error && reason.name !== "AbortError") setError("The invitation could not be shared."); }
    } else await copyText(inviteLink);
  }

  async function createPairCode() {
    setWorking("pair-code"); setError("");
    try {
      const result = await api<{ code: string; expiresInSeconds: number }>("/api/devices/pairings", { method: "POST", body: "{}" });
      setPairingCode(result.code);
      await refreshInvitations();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Pairing code could not be created."); }
    finally { setWorking(""); }
  }

  async function pairDevice(event: React.FormEvent) {
    event.preventDefault();
    setWorking("pair-device"); setError(""); setMessage("");
    try {
      const device = await collectDeviceInfo();
      const result = await api<{ device: Device }>("/api/devices/pair", {
        method: "POST", body: JSON.stringify({ code: pairInput, metadata: device }),
      });
      storeDeviceId(result.device.id);
      setPairInput("");
      setMessage("This browser has been paired with your account.");
      await refreshData();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Pairing could not be completed."); }
    finally { setWorking(""); }
  }

  async function changeDevice(id: string, action: "rename" | "disconnect" | "remove") {
    const device = devices.find((item) => item.id === id);
    if (!device) return;
    if (action === "remove" && !window.confirm(`Remove “${device.display_name}” and its retained sharing history? This cannot be undone.`)) return;
    if (action === "disconnect" && !window.confirm(`Disconnect “${device.display_name}” and revoke its active shares?`)) return;
    setError(""); setMessage(""); setWorking(`${action}-${id}`);
    try {
      if (action === "rename") {
        const name = window.prompt("Name this device", device.display_name)?.trim();
        if (!name) return;
        await api(`/api/devices/${id}`, { method: "PATCH", body: JSON.stringify({ displayName: name }) });
        setMessage("Device name updated.");
      } else if (action === "disconnect") {
        await api(`/api/devices/${id}/disconnect`, { method: "POST", body: "{}" });
        stopLocationWatch(id);
        setMessage("Device disconnected; its location-sharing sessions have been revoked.");
      } else {
        await api(`/api/devices/${id}`, { method: "DELETE" });
        if (id === getStoredDeviceId()) {
          stopLocationWatch(id);
          try { localStorage.removeItem("nexus.current-device"); } catch { /* Ignore storage restrictions. */ }
        }
        setMessage("Device and its retained location points have been removed.");
      }
      await refreshData();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Device action failed."); }
    finally { setWorking(""); }
  }

  async function revokeInvitation(id: string) {
    try {
      await api(`/api/invitations/${id}`, { method: "DELETE" });
      await refreshInvitations();
      setMessage("Invitation revoked.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Invitation could not be revoked."); }
  }

  async function loadHistory(id: string) {
    setWorking(`history-${id}`);
    setError("");
    try {
      const result = await api<{ points: HistoryPoint[] }>(`/api/shares/${id}/history`);
      setHistory((current) => ({ ...current, [id]: result.points }));
      setHistoryOpen(id);
      const log = await api<{ events: AuditEvent[] }>("/api/privacy/audit");
      setEvents(log.events);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Location history could not be loaded."); }
    finally { setWorking(""); }
  }

  async function deleteLocationData() {
    if (!window.confirm("Delete all retained location points you can access? Sharing permissions remain unchanged, but the map will be empty until new points arrive.")) return;
    setWorking("delete-locations");
    try {
      await api("/api/privacy/location-data", { method: "DELETE" });
      setMessage("Retained location points have been deleted.");
      setHistory({});
      await refreshData();
      const log = await api<{ events: AuditEvent[] }>("/api/privacy/audit");
      setEvents(log.events);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Location data could not be deleted."); }
    finally { setWorking(""); }
  }

  async function submitReport(event: React.FormEvent) {
    event.preventDefault(); setWorking("report");
    try {
      await api("/api/reports", { method: "POST", body: JSON.stringify({ category: reportCategory, details: reportDetails }) });
      setReportDetails(""); setReportSuccess(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Report could not be submitted."); }
    finally { setWorking(""); }
  }

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault(); setWorking("profile");
    try {
      const result = await api<{ user: CurrentUser }>("/api/auth/account", { method: "PATCH", body: JSON.stringify({ displayName: profileName }) });
      onUserChange(result.user); setMessage("Profile updated.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Profile could not be updated."); }
    finally { setWorking(""); }
  }

  async function updatePassword(event: React.FormEvent) {
    event.preventDefault(); setWorking("password"); setError("");
    try {
      await api("/api/auth/account/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      onLogout();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Password could not be updated."); }
    finally { setWorking(""); }
  }

  async function logoutAll() {
    if (!window.confirm("Log out every active session for your account, including this browser?")) return;
    setWorking("logout-all");
    try {
      await api("/api/auth/logout-all", { method: "POST", body: "{}" });
      onLogout();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Other sessions could not be closed."); }
    finally { setWorking(""); }
  }

  async function deleteAccount(event: React.FormEvent) {
    event.preventDefault();
    if (!window.confirm("Permanently delete your account, registered devices, invitations, sharing sessions, and all retained location points? This cannot be undone.")) return;
    setWorking("delete-account");
    try {
      await api("/api/auth/account", { method: "DELETE", body: JSON.stringify({ password: accountPassword }) });
      onLogout();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Account could not be deleted."); }
    finally { setWorking(""); }
  }

  async function performLogout() {
    setWorking("logout");
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); onLogout(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not sign out."); }
    finally { setWorking(""); }
  }

  async function selectSection(value: Section) {
    setSection(value); setMobileNavOpen(false); setMessage(""); setError("");
    if (value === "devices") void refreshInvitations().catch(() => undefined);
    if (value === "privacy") {
      try { const result = await api<{ events: AuditEvent[] }>("/api/privacy/audit"); setEvents(result.events); } catch { /* Main content will show request feedback. */ }
    }
  }

  if (loading) return <div className="loading-screen"><span className="loader-orbit" /><p>Loading your private dashboard…</p></div>;

  const sectionTitle: Record<Section, string> = {
    overview: "Overview", devices: "My devices", privacy: "Privacy center", settings: "Account settings", admin: "Admin console",
  };
  const sectionSubtitle: Record<Section, string> = {
    overview: "Your devices, permissions, and authorized location activity.",
    devices: "Register and manage the devices you control.",
    privacy: "See access, review history, and take back control.",
    settings: "Manage your profile and active account sessions.",
    admin: "Platform operations and safety controls.",
  };

  return (
    <div className="app-shell">
      {mobileNavOpen && <button className="mobile-nav-backdrop" aria-label="Close menu" onClick={() => setMobileNavOpen(false)} />}
      <aside className={`sidebar ${mobileNavOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand"><div className="brand-mark"><Fingerprint size={21} /></div><div><strong>NEXUS</strong><span>LOCATOR</span></div><button className="sidebar-close mobile-only" onClick={() => setMobileNavOpen(false)} aria-label="Close menu"><X size={17} /></button></div>
        <div className="sidebar-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          <NavItem icon={<Activity size={17} />} title="Overview" active={section === "overview"} onClick={() => void selectSection("overview")} />
          <NavItem icon={<Smartphone size={17} />} title="My devices" count={devices.length || undefined} active={section === "devices"} onClick={() => void selectSection("devices")} />
          <NavItem icon={<ShieldCheck size={17} />} title="Privacy center" active={section === "privacy"} onClick={() => void selectSection("privacy")} />
          <NavItem icon={<Settings2 size={17} />} title="Account settings" active={section === "settings"} onClick={() => void selectSection("settings")} />
          {user.role === "admin" && <><div className="sidebar-label admin-label">OPERATIONS</div><NavItem icon={<ShieldAlert size={17} />} title="Admin console" active={section === "admin"} onClick={() => void selectSection("admin")} /></>}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-privacy"><div className="privacy-shield"><Shield size={17} /></div><strong>Privacy first</strong><p>No hidden tracking. Every location is shared by an authorized device owner.</p><a href="/privacy">How data is handled <ChevronRight size={13} /></a></div>
        <div className="sidebar-user">
          <div className="avatar">{user.displayName.trim().charAt(0).toUpperCase()}</div>
          <div className="sidebar-user-meta"><strong>{user.displayName}</strong><span>{user.role === "admin" ? "Administrator" : "Personal account"}</span></div>
          <button className="icon-button sidebar-logout" onClick={() => void performLogout()} title="Sign out" aria-label="Sign out"><LogOut size={16} /></button>
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileNavOpen(true)} aria-label="Open menu"><Menu size={19} /></button>
          <div className="breadcrumb"><span>Workspace</span><ChevronRight size={13} /><strong>{sectionTitle[section]}</strong></div>
          <div className="topbar-right"><span className="secure-tag top-secure"><LockKeyhole size={12} /> SECURE SESSION</span><span className="top-avatar">{user.displayName.charAt(0).toUpperCase()}</span></div>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <div><span className="section-kicker">{section === "admin" ? "PLATFORM MANAGEMENT" : "NEXUS / " + section.toUpperCase()}</span><h1>{section === "overview" ? `Good ${greeting()}, ${user.displayName.split(" ")[0]}` : sectionTitle[section]}</h1><p>{sectionSubtitle[section]}</p></div>
            <div className="heading-status"><span className="green-pulse" /> CONSENT STATUS <strong>{activeCount} ACTIVE</strong><button className="icon-button refresh-button" title="Refresh data" aria-label="Refresh data" onClick={() => { void refreshData().catch((reason) => setError(reason.message)); }}><RefreshCw size={15} /></button></div>
          </div>

          {message && <div className="toast toast-success" role="status"><Check size={16} />{message}<button className="icon-button" aria-label="Dismiss" onClick={() => setMessage("")}><X size={15} /></button></div>}
          {error && <div className="toast toast-error" role="alert"><AlertTriangle size={16} />{error}<button className="icon-button" aria-label="Dismiss" onClick={() => setError("")}><X size={15} /></button></div>}

          {section === "overview" && <Overview
            user={user} devices={devices} shares={shares} activeShares={activeShares} selectedShare={selectedShare}
            activeCount={activeCount} liveCount={liveCount} staleLocation={staleLocation}
            onStartShare={() => void beginOwnSharing()} onStop={stopShare} onSection={selectSection} working={working}
          />}
          {section === "devices" && <DevicesSection
            devices={devices} shares={shares} invitations={invitations} inviteTarget={inviteTarget} inviteLink={inviteLink}
            pairingCode={pairingCode} pairInput={pairInput} working={working}
            setInviteTarget={setInviteTarget} setPairInput={setPairInput} createInvitation={createInvitation}
            createPairCode={createPairCode} pairDevice={pairDevice} register={registerCurrentDevice}
            changeDevice={changeDevice} revokeInvitation={revokeInvitation} copyText={copyText} shareInvite={shareInvite}
          />}
          {section === "privacy" && <PrivacySection
            user={user} shares={shares} events={events} history={history} historyOpen={historyOpen} working={working}
            onStop={stopShare} onStopAll={stopAllSharing} onLoadHistory={loadHistory} setHistoryOpen={setHistoryOpen}
            onDeleteLocation={deleteLocationData} reportCategory={reportCategory} reportDetails={reportDetails}
            setReportCategory={setReportCategory} setReportDetails={setReportDetails} onReport={submitReport}
            reportSuccess={reportSuccess} setReportSuccess={setReportSuccess}
          />}
          {section === "settings" && <SettingsSection
            user={user} profileName={profileName} setProfileName={setProfileName} saveProfile={saveProfile}
            currentPassword={currentPassword} newPassword={newPassword} setCurrentPassword={setCurrentPassword}
            setNewPassword={setNewPassword} updatePassword={updatePassword} logoutAll={logoutAll}
            accountPassword={accountPassword} setAccountPassword={setAccountPassword} deleteAccount={deleteAccount}
            working={working} onLogout={performLogout}
          />}
          {section === "admin" && user.role === "admin" && <AdminPanel />}
          {section === "admin" && user.role !== "admin" && <div className="card empty-admin"><ShieldAlert size={24} /><strong>Administrator access required</strong><p>This section is limited to authorized platform administrators.</p></div>}
          <footer className="app-footer"><span>© {new Date().getFullYear()} NEXUS LOCATOR</span><span><a href="/terms">TERMS</a><a href="/privacy">PRIVACY POLICY</a><span className="footer-live-dot" /> OWNER CONSENT REQUIRED</span></footer>
        </div>
      </main>
    </div>
  );
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}

function NavItem({ icon, title, count, active, onClick }: { icon: React.ReactNode; title: string; count?: number; active: boolean; onClick: () => void }) {
  return <button className={`nav-item ${active ? "nav-item-active" : ""}`} onClick={onClick}>{icon}<span>{title}</span>{count !== undefined && <small>{count}</small>}</button>;
}

function Overview({ user, devices, shares, activeShares, selectedShare, activeCount, liveCount, staleLocation, onStartShare, onStop, onSection, working }: {
  user: CurrentUser; devices: Device[]; shares: Share[]; activeShares: Share[]; selectedShare: Share | null;
  activeCount: number; liveCount: number; staleLocation: boolean; onStartShare: () => void;
  onStop: (share: Share) => void; onSection: (section: Section) => void; working: string;
}) {
  const ownActive = activeShares.some((item) => item.owner_id === user.id && item.device_id === getStoredDeviceId());
  const hasDevice = devices.some((item) => item.id === getStoredDeviceId());
  return (
    <>
      <div className="metrics-grid">
        <MetricCard icon={<Smartphone size={17} />} label="MY DEVICES" value={devices.length} detail={devices.length === 1 ? "registered device" : "registered devices"} tone="red" />
        <MetricCard icon={<Radio size={17} />} label="ACTIVE SHARING" value={activeCount} detail={`${liveCount} updating now`} tone="blue" badge={activeCount ? "PERMISSIONED" : "OFF"} />
        <MetricCard icon={<MapPin size={17} />} label="LAST KNOWN LOCATION" value={selectedShare?.recorded_at ? relative(selectedShare.recorded_at) : "—"} detail={selectedShare ? selectedShare.device_name : "No location shared"} tone="red" />
        <MetricCard icon={<Gauge size={17} />} label="LOCATION ACCURACY" value={selectedShare?.accuracy != null ? `±${Math.round(selectedShare.accuracy)} m` : "—"} detail={selectedShare?.recorded_at ? (staleLocation ? "Last known · not updating" : "Current browser reading") : "Awaiting permission"} tone="blue" />
      </div>

      <div className="dashboard-grid">
        <section className="card map-card">
          <div className="card-heading">
            <div><span className="section-kicker">REAL-TIME MAP</span><h2>Live locations</h2></div>
            {selectedShare?.latitude != null && <span className={`live-pill ${staleLocation ? "is-stale" : ""}`}><i />{staleLocation ? "LAST KNOWN" : "LIVE"}</span>}
          </div>
          <LocationMap share={selectedShare} />
          <div className="map-card-footer">
            <div><span className={`map-footer-dot ${selectedShare?.device_online && !staleLocation ? "is-online" : ""}`} /><span>{selectedShare ? selectedShare.device_name : "No shared device"}</span><span className="muted-separator">·</span><span>{selectedShare ? (selectedShare.device_online && !staleLocation ? "Connected" : "Offline or stale") : "No active permission"}</span></div>
            <button className="text-button" onClick={() => onSection("privacy")}>Privacy details <ChevronRight size={13} /></button>
          </div>
        </section>
        <section className="card quick-card">
          <div className="card-heading"><div><span className="section-kicker">DEVICE STATUS</span><h2>This device</h2></div><span className="device-mini-icon"><Smartphone size={17} /></span></div>
          <div className="device-status-name"><div className={`status-signal ${hasDevice ? "signal-on" : ""}`} /><div><strong>{devices.find((item) => item.id === getStoredDeviceId())?.display_name ?? "Not registered"}</strong><span>{hasDevice ? "This browser · " + (devices.find((item) => item.id === getStoredDeviceId())?.operating_system ?? "Unknown OS") : "Register the current browser to begin"}</span></div></div>
          <div className="status-detail-list">
            <StatusDetail icon={<Radio size={14} />} label="SHARING" value={ownActive ? "Active" : "Off"} active={ownActive} />
            <StatusDetail icon={<Battery size={14} />} label="BATTERY" value={devices.find((item) => item.id === getStoredDeviceId())?.battery_percent != null ? `${devices.find((item) => item.id === getStoredDeviceId())?.battery_percent}%` : "Not available in this browser"} />
            <StatusDetail icon={<Network size={14} />} label="NETWORK" value={navigator.onLine ? (devices.find((item) => item.id === getStoredDeviceId())?.connection_type ?? "Connected · type unavailable") : "Offline"} active={navigator.onLine} />
            <StatusDetail icon={<Clock3 size={14} />} label="LAST SEEN" value={relative(devices.find((item) => item.id === getStoredDeviceId())?.last_seen)} />
          </div>
          {ownActive
            ? <button className="button button-danger-outline full-button" onClick={() => { const own = activeShares.find((item) => item.owner_id === user.id && item.device_id === getStoredDeviceId()); if (own) onStop(own); }} disabled={working.startsWith("stop-")}><X size={15} />Stop this device sharing</button>
            : <button className="button button-primary full-button" onClick={hasDevice ? onStartShare : () => onSection("devices")} disabled={working === "share"}>{working === "share" ? "Waiting for location permission…" : <>{hasDevice ? <><MapPin size={15} />Start sharing this device</> : <><Plus size={15} />Register this device</>}</>}</button>}
          <p className="card-footnote"><LockKeyhole size={12} /> Your location is not read until you start sharing.</p>
        </section>
      </div>

      <div className="lower-grid">
        <section className="card sharing-card">
          <div className="card-heading">
            <div><span className="section-kicker">AUTHORIZED ACCESS</span><h2>Active sharing</h2></div>
            <button className="text-button" onClick={() => onSection("privacy")}>View all <ChevronRight size={13} /></button>
          </div>
          {activeShares.length ? <div className="sharing-list">
            {activeShares.slice(0, 4).map((share) => {
              const isMine = share.owner_id === user.id;
              return <div className="sharing-row" key={share.id}>
                <div className={`sharing-avatar ${share.device_online ? "avatar-online" : ""}`}>{isMine ? <Smartphone size={15} /> : <UserRound size={15} />}</div>
                <div className="sharing-row-info"><strong>{share.device_name}</strong><span>{isMine ? `You’re sharing with ${share.viewer_name}` : `${share.owner_name} is sharing with you`}</span></div>
                <div className="sharing-last"><span className={`mini-dot ${share.device_online && share.latitude != null ? "green-dot" : ""}`} />{share.device_online && share.latitude != null ? "Live" : share.recorded_at ? relative(share.recorded_at) : "Waiting"}</div>
                <button className="icon-button tiny-icon danger-hover" title="Revoke this access" aria-label="Revoke this access" onClick={() => onStop(share)}><X size={14} /></button>
              </div>;
            })}
          </div> : <div className="empty-inline"><ShieldCheck size={18} /><span>No active location-sharing sessions. Nothing is being tracked.</span></div>}
          <div className="sharing-card-actions"><button className="button button-subtle" onClick={() => onSection("devices")}><Plus size={14} />Invite a device</button><span><span className="green-pulse" /> Owner consent required</span></div>
        </section>
        <section className="card privacy-spotlight">
          <span className="privacy-spotlight-orbit"><ShieldCheck size={23} /></span>
          <span className="section-kicker">YOUR CONTROL</span>
          <h2>Sharing is always<br />your decision.</h2>
          <p>Review who has access, see when a location was viewed, or stop every session in one action.</p>
          <div className="privacy-spotlight-meta"><span><LockKeyhole size={13} />Encrypted</span><span><Clock3 size={13} />24h default retention</span></div>
          <button className="text-button" onClick={() => onSection("privacy")}>Open privacy center <ChevronRight size={13} /></button>
        </section>
      </div>

      <section className="consent-banner"><div className="consent-icon"><Shield size={17} /></div><div><strong>Location sharing requires the device owner’s permission.</strong><span>A phone number or email address cannot independently reveal someone’s GPS location.</span></div><a href="/privacy" className="text-button">Read privacy policy <ExternalLink size={13} /></a></section>
    </>
  );
}

function MetricCard({ icon, label, value, detail, tone, badge }: { icon: React.ReactNode; label: string; value: React.ReactNode; detail: string; tone: "red" | "blue"; badge?: string }) {
  return <div className="card metric-card"><div className={`metric-icon metric-${tone}`}>{icon}</div>{badge && <span className="metric-badge">{badge}</span>}<span className="section-kicker">{label}</span><strong className={`metric-value ${typeof value === "string" && value.length > 8 ? "metric-word-value" : ""}`}>{value}</strong><span className="metric-detail">{detail}</span></div>;
}

function StatusDetail({ icon, label, value, active }: { icon: React.ReactNode; label: string; value: string; active?: boolean }) {
  return <div className="status-detail"><span className="status-detail-icon">{icon}</span><span className="status-detail-label">{label}</span><span className={`status-detail-value ${active ? "value-active" : ""}`}>{value}</span></div>;
}

function DevicesSection(props: {
  devices: Device[]; shares: Share[]; invitations: Invitation[]; inviteTarget: string; inviteLink: string; pairingCode: string;
  pairInput: string; working: string; setInviteTarget: (value: string) => void; setPairInput: (value: string) => void;
  createInvitation: (event: React.FormEvent) => void; createPairCode: () => void; pairDevice: (event: React.FormEvent) => void;
  register: () => void; changeDevice: (id: string, action: "rename" | "disconnect" | "remove") => void;
  revokeInvitation: (id: string) => void; copyText: (value: string) => void; shareInvite: () => void;
}) {
  const ownActive = props.shares.filter((share) => share.owner_id === share.viewer_id && !share.stopped_at && !share.revoked_at);
  return (
    <div className="section-content">
      <section className="card section-card">
        <div className="card-heading"><div><span className="section-kicker">REGISTERED HARDWARE</span><h2>My devices</h2></div><span className="count-pill">{props.devices.length} {props.devices.length === 1 ? "device" : "devices"}</span></div>
        <div className="section-explainer">Device details come from this browser. Battery and network type are shown only when your browser makes them available.</div>
        <div className="device-register-row"><div className="register-copy"><span className="register-icon"><Smartphone size={18} /></span><div><strong>Register this browser</strong><span>Create a device record for the device you are using now.</span></div></div><button className="button button-primary" onClick={props.register} disabled={props.working === "register"}>{props.working === "register" ? "Registering…" : <><Plus size={15} />{props.devices.some((d) => d.id === getStoredDeviceId()) ? "Refresh device details" : "Register device"}</>}</button></div>
        <div className="device-list">
          {props.devices.length ? props.devices.map((device) => {
            const sharing = props.shares.filter((share) => share.device_id === device.id && !share.stopped_at && !share.revoked_at).length;
            return <div className="device-row" key={device.id}>
              <div className={`device-row-icon ${device.online ? "device-row-online" : ""}`}><Smartphone size={18} /></div>
              <div className="device-main"><strong>{device.display_name}{device.id === getStoredDeviceId() && <span className="this-device-tag">THIS DEVICE</span>}</strong><span>{device.operating_system} · {device.browser}{device.screen_info ? ` · ${device.screen_info}` : ""}</span><span className="device-row-muted">Last seen {relative(device.last_seen)} · {device.battery_percent != null ? `${device.battery_percent}% battery` : "battery unavailable"} · {device.connection_type ?? "network type unavailable"}</span></div>
              <span className={`device-state ${device.online ? "device-state-online" : ""}`}><i />{device.online ? "Online" : "Offline"}</span>
              {sharing > 0 && <span className="count-pill">{sharing} sharing</span>}
              <details className="device-actions-menu"><summary className="icon-button" aria-label="Device actions"><MoreHorizontal size={17} /></summary><div><button onClick={() => props.changeDevice(device.id, "rename")}>Rename device</button><button onClick={() => props.changeDevice(device.id, "disconnect")}>Disconnect & revoke</button><button className="menu-danger" onClick={() => props.changeDevice(device.id, "remove")}>Remove device</button></div></details>
            </div>;
          }) : <div className="empty-inline"><HardDrive size={18} /><span>No devices registered yet. Register this browser before sharing its location.</span></div>}
        </div>
      </section>

      <div className="two-column-grid">
        <section className="card section-card invite-form-card">
          <div className="card-heading"><div><span className="section-kicker">REQUEST CONSENT</span><h2>Invite a device owner</h2></div><span className="soft-icon"><Users size={17} /></span></div>
          <p className="section-description">Enter an email or phone number to label the request. This does not locate the person or send them a message automatically.</p>
          <form className="invite-form" onSubmit={props.createInvitation}>
            <label className="field-label">Recipient email or phone<input value={props.inviteTarget} onChange={(event) => props.setInviteTarget(event.target.value)} placeholder="name@example.com or +1 555 0100" minLength={5} maxLength={320} required /></label>
            <button className="button button-primary full-button" disabled={props.working === "invite"}>{props.working === "invite" ? "Creating secure link…" : <><Link2 size={15} />Create one-time invite link</>}</button>
          </form>
          {props.inviteLink && <div className="invite-link-box"><div><span className="tiny-label">PRIVATE ONE-TIME LINK · EXPIRES IN 48 HOURS</span><span className="invite-url">{props.inviteLink}</span></div><div className="invite-link-actions"><button className="button button-subtle" onClick={() => props.copyText(props.inviteLink)}><Copy size={14} />Copy</button><button className="button button-subtle" onClick={props.shareInvite}><ExternalLink size={14} />Share link</button></div></div>}
          <div className="safety-note"><ShieldCheck size={14} /><span>The recipient must sign in, approve on the device they want to share, and grant location permission.</span></div>
        </section>

        <section className="card section-card pair-card">
          <div className="card-heading"><div><span className="section-kicker">SECURE PAIRING</span><h2>Pair a new browser</h2></div><span className="soft-icon soft-blue"><KeyRound size={17} /></span></div>
          <p className="section-description">Pairing codes only register a new browser to your existing account. The code expires after 10 minutes and can be used once.</p>
          <button className="button button-subtle full-button" onClick={props.createPairCode} disabled={props.working === "pair-code"}>{props.working === "pair-code" ? "Creating code…" : <><KeyRound size={15} />Generate a pairing code</>}</button>
          {props.pairingCode && <div className="pair-code-result"><span className="tiny-label">ONE-TIME CODE · 10 MINUTES</span><strong>{props.pairingCode}</strong><button className="text-button" onClick={() => props.copyText(props.pairingCode)}><Copy size={13} />Copy code</button></div>}
          <form className="pair-input-row" onSubmit={props.pairDevice}><label className="field-label">Enter your account’s pairing code<input value={props.pairInput} onChange={(event) => props.setPairInput(event.target.value.toUpperCase())} placeholder="Paste 12-character code" autoCapitalize="characters" minLength={8} maxLength={20} required /></label><button className="button button-outline" type="submit" disabled={props.working === "pair-device"}>{props.working === "pair-device" ? "Pairing…" : "Pair browser"}</button></form>
        </section>
      </div>

      <section className="card section-card">
        <div className="card-heading"><div><span className="section-kicker">LINK MANAGEMENT</span><h2>Invitations</h2></div><span className="count-pill">{props.invitations.length} total</span></div>
        {props.invitations.length ? <div className="invitation-table">
          <div className="table-header"><span>INVITED CONTACT</span><span>CREATED</span><span>STATUS</span><span>ACTION</span></div>
          {props.invitations.map((invite) => <div className="invitation-row" key={invite.id}><span>{invite.target}</span><span>{relative(invite.created_at)}</span><span><span className={`invite-state ${invite.accepted_at ? "invite-accepted" : invite.usable ? "invite-pending" : "invite-closed"}`} />{invite.accepted_at ? "Approved" : invite.usable ? "Awaiting response" : invite.revoked_at ? "Revoked" : "Expired"}</span><span>{invite.usable && <button className="text-button danger-text" onClick={() => props.revokeInvitation(invite.id)}>Revoke link</button>}</span></div>)}
        </div> : <div className="empty-inline"><Link2 size={17} /><span>You have not created any invitations.</span></div>}
        <div className="invitation-delivery-note"><AlertTriangle size={14} /><span>Invitation delivery is manual. Nexus does not send email or SMS; copy or share the secure link directly with the intended device owner.</span></div>
      </section>
    </div>
  );
}

function PrivacySection(props: {
  user: CurrentUser; shares: Share[]; events: AuditEvent[]; history: Record<string, HistoryPoint[]>; historyOpen: string | null;
  working: string; onStop: (share: Share) => void; onStopAll: () => void; onLoadHistory: (id: string) => void;
  setHistoryOpen: (id: string | null) => void; onDeleteLocation: () => void; reportCategory: string; reportDetails: string;
  setReportCategory: (value: string) => void; setReportDetails: (value: string) => void;
  onReport: (event: React.FormEvent) => void; reportSuccess: boolean; setReportSuccess: (value: boolean) => void;
}) {
  const active = props.shares.filter((share) => !share.stopped_at && !share.revoked_at);
  const historyShares = props.shares.filter((share) => share.stopped_at || share.revoked_at);
  const accessCount = active.filter((share) => share.viewer_id === props.user.id && share.owner_id !== props.user.id).length;
  return (
    <div className="section-content">
      <div className="privacy-summary-grid">
        <MetricCard icon={<Radio size={17} />} label="ACTIVE SHARES" value={active.length} detail="Current sharing permissions" tone="red" />
        <MetricCard icon={<Users size={17} />} label="VIEWERS WITH ACCESS" value={new Set(active.filter((share) => share.owner_id === props.user.id).map((share) => share.viewer_id)).size} detail="Accounts you have approved" tone="blue" />
        <MetricCard icon={<Eye size={17} />} label="SHARED WITH YOU" value={accessCount} detail="Devices currently visible to you" tone="red" />
        <MetricCard icon={<Clock3 size={17} />} label="LOCATION RETENTION" value="24 hours" detail="Default maximum; configured by operator" tone="blue" />
      </div>
      <section className="stop-all-panel">
        <div className="stop-all-icon"><ShieldAlert size={21} /></div><div><span className="section-kicker">IMMEDIATE CONTROL</span><h2>Stop all location sharing</h2><p>Close every sharing session you own or view. All other accounts lose access to your shared devices immediately.</p></div><button className="button button-danger" onClick={props.onStopAll} disabled={!active.length || props.working === "stop-all"}><X size={15} />{props.working === "stop-all" ? "Stopping…" : "Stop all sharing"}</button>
      </section>

      <section className="card section-card">
        <div className="card-heading"><div><span className="section-kicker">ACCESS CONTROL</span><h2>Who can see a location</h2></div><span className="count-pill">{active.length} active</span></div>
        {active.length ? <div className="access-list">{active.map((share) => {
          const owner = share.owner_id === props.user.id;
          const otherPerson = owner ? share.viewer_name : share.owner_name;
          const canSee = owner ? "has access to this device" : "is sharing a device with you";
          return <div className="access-row" key={share.id}>
            <div className={`access-icon ${share.device_online ? "access-icon-online" : ""}`}>{owner ? <UserRound size={16} /> : <Smartphone size={16} />}</div>
            <div className="access-primary"><strong>{owner ? share.device_name : otherPerson}</strong><span>{owner ? `${otherPerson} ${canSee}` : `${otherPerson} ${canSee}`}</span><small>Started {dateTime(share.started_at)}{share.last_access_at ? ` · Last viewed ${relative(share.last_access_at)}` : ""}</small></div>
            <div className="access-device"><span>{owner ? otherPerson : share.device_name}</span><small>{share.device_online && share.latitude != null ? "LIVE" : share.recorded_at ? `LAST SEEN ${relative(share.recorded_at).toUpperCase()}` : "WAITING FOR LOCATION"}</small></div>
            <button className="button button-danger-outline" onClick={() => props.onStop(share)} disabled={props.working === `stop-${share.id}`}><X size={13} />Revoke access</button>
          </div>;
        })}</div> : <div className="empty-inline"><ShieldCheck size={18} /><span>No active sharing sessions. You have not granted or received current location access.</span></div>}
      </section>

      <section className="card section-card">
        <div className="card-heading"><div><span className="section-kicker">RECENT SESSIONS</span><h2>Sharing history</h2></div><span className="count-pill">14-day summary</span></div>
        {historyShares.length ? <div className="history-list">{historyShares.map((share) => {
          const visible = props.historyOpen === share.id;
          const points = props.history[share.id];
          const owns = share.owner_id === props.user.id;
          return <div className="history-item" key={share.id}>
            <div className="history-item-header"><div className="history-icon"><Clock3 size={15} /></div><div className="history-info"><strong>{share.device_name}</strong><span>{owns ? `Owner · shared with ${share.viewer_name}` : `Viewer · shared by ${share.owner_name}`}</span><small>Started {dateTime(share.started_at)} · Stopped {dateTime(share.stopped_at)}</small></div><span className="history-closed">CLOSED</span><button className="button button-subtle" onClick={() => visible ? props.setHistoryOpen(null) : props.onLoadHistory(share.id)}>{visible ? "Hide points" : props.working === `history-${share.id}` ? "Loading…" : "View retained points"}</button></div>
            {visible && <div className="history-points">{points?.length ? points.map((point, index) => <div key={`${point.recordedAt}-${index}`}><span>{dateTime(point.recordedAt)}</span><span>Lat {point.latitude.toFixed(5)}, Lng {point.longitude.toFixed(5)}</span><span>±{Math.round(point.accuracy)} m</span></div>) : <p>No location points remain within the retention window. They expire automatically.</p>}</div>}
          </div>;
        })}</div> : <div className="empty-inline"><Clock3 size={18} /><span>Sharing sessions will appear here after location sharing begins.</span></div>}
      </section>

      <div className="two-column-grid privacy-tools-grid">
        <section className="card section-card">
          <div className="card-heading"><div><span className="section-kicker">ACCOUNT ACTIVITY</span><h2>Privacy audit log</h2></div><span className="soft-icon"><FileText size={16} /></span></div>
          <p className="section-description">Events that can affect your location privacy. Audit entries do not store coordinates.</p>
          {props.events.length ? <div className="audit-list">{props.events.slice(0, 12).map((event) => <div className="audit-row" key={event.id}><span className="audit-event-dot" /><div><strong>{auditLabel(event.event_type)}</strong><span>{dateTime(event.created_at)}</span></div></div>)}</div> : <div className="empty-inline"><FileText size={16} /><span>No privacy events recorded yet.</span></div>}
        </section>
        <section className="card section-card privacy-tools">
          <div className="card-heading"><div><span className="section-kicker">YOUR DATA</span><h2>Delete location history</h2></div><span className="soft-icon soft-red"><Trash2 size={16} /></span></div>
          <p className="section-description">Delete every unexpired location point in sessions you own or can view. This does not change current sharing permissions.</p>
          <button className="button button-danger-outline full-button" onClick={props.onDeleteLocation} disabled={props.working === "delete-locations"}><Trash2 size={14} />{props.working === "delete-locations" ? "Deleting points…" : "Delete retained location points"}</button>
          <div className="tool-separator" />
          <span className="section-kicker">REPORT A SAFETY CONCERN</span>
          {props.reportSuccess ? <div className="report-success"><Check size={16} /><span>Your report was sent to the platform safety team.</span><button className="text-button" onClick={() => props.setReportSuccess(false)}>Send another</button></div> : <form className="report-form" onSubmit={props.onReport}>
            <select value={props.reportCategory} onChange={(event) => props.setReportCategory(event.target.value)} aria-label="Report category"><option value="unauthorized_access">Unauthorized access</option><option value="unsafe_invitation">Unsafe invitation</option><option value="account_security">Account security</option><option value="other">Other</option></select>
            <textarea value={props.reportDetails} onChange={(event) => props.setReportDetails(event.target.value)} minLength={10} maxLength={2000} placeholder="Describe the concern without including sensitive location details." required />
            <button className="button button-subtle" disabled={props.working === "report"}><ShieldAlert size={14} />{props.working === "report" ? "Submitting…" : "Submit report"}</button>
          </form>}
        </section>
      </div>
      <div className="notice-banner privacy-notice"><span className="notice-dot" /><p>A phone number or email address cannot independently reveal someone’s GPS location. Invitation links only request consent.</p></div>
    </div>
  );
}

function auditLabel(event: string) {
  const labels: Record<string, string> = {
    sharing_started: "Location sharing started", sharing_stopped: "Location access revoked or sharing stopped",
    location_accessed: "An authorized location was viewed", location_history_accessed: "Retained location history was viewed",
    location_data_deleted: "Retained location points deleted", all_sharing_stopped: "All sharing stopped",
    invitation_created: "One-time invitation link created", invitation_revoked: "Invitation link revoked",
    invitation_declined: "Invitation declined", device_registered: "Device registered", device_renamed: "Device renamed",
    device_disconnected: "Device disconnected", device_removed: "Device removed", device_paired: "Device paired",
    account_created: "Account created", account_login: "Signed in", account_logout: "Signed out",
    sessions_revoked: "All sessions signed out", password_changed: "Password changed",
    abuse_report_submitted: "Safety report submitted",
  };
  return labels[event] ?? event.replaceAll("_", " ");
}

function SettingsSection(props: {
  user: CurrentUser; profileName: string; setProfileName: (value: string) => void; saveProfile: (event: React.FormEvent) => void;
  currentPassword: string; newPassword: string; setCurrentPassword: (value: string) => void; setNewPassword: (value: string) => void;
  updatePassword: (event: React.FormEvent) => void; logoutAll: () => void; accountPassword: string;
  setAccountPassword: (value: string) => void; deleteAccount: (event: React.FormEvent) => void;
  working: string; onLogout: () => void;
}) {
  return (
    <div className="section-content settings-layout">
      <div className="settings-column">
        <section className="card section-card settings-card">
          <div className="card-heading"><div><span className="section-kicker">PROFILE</span><h2>Account details</h2></div><span className="soft-icon"><UserRound size={17} /></span></div>
          <form className="form-stack settings-form" onSubmit={props.saveProfile}>
            <label className="field-label">Display name<input value={props.profileName} onChange={(event) => props.setProfileName(event.target.value)} minLength={1} maxLength={80} required /></label>
            <label className="field-label">Email address<input value={props.user.email} disabled /><small>Account email changes require email verification, which is not configured in this deployment.</small></label>
            <button className="button button-primary" disabled={props.working === "profile"}>{props.working === "profile" ? "Saving…" : "Save profile"}</button>
          </form>
        </section>
        <section className="card section-card settings-card">
          <div className="card-heading"><div><span className="section-kicker">AUTHENTICATION</span><h2>Change password</h2></div><span className="soft-icon soft-blue"><KeyRound size={17} /></span></div>
          <p className="section-description">Choose at least 10 characters. Changing your password signs out all sessions.</p>
          <form className="form-stack settings-form" onSubmit={props.updatePassword}>
            <label className="field-label">Current password<input type="password" autoComplete="current-password" value={props.currentPassword} onChange={(event) => props.setCurrentPassword(event.target.value)} maxLength={128} required /></label>
            <label className="field-label">New password<input type="password" autoComplete="new-password" value={props.newPassword} onChange={(event) => props.setNewPassword(event.target.value)} minLength={10} maxLength={128} required /></label>
            <button className="button button-subtle" disabled={props.working === "password"}><KeyRound size={14} />{props.working === "password" ? "Updating…" : "Update password"}</button>
          </form>
        </section>
        <section className="card section-card settings-card">
          <div className="card-heading"><div><span className="section-kicker">SESSION SECURITY</span><h2>Active sessions</h2></div><span className="soft-icon soft-red"><LockKeyhole size={17} /></span></div>
          <p className="section-description">Your browser uses an HTTP-only, eight-hour session cookie. Log out all devices if a session may be exposed.</p>
          <div className="settings-action-row"><div><strong>Log out all devices</strong><span>This includes the session you are using now.</span></div><button className="button button-danger-outline" onClick={props.logoutAll} disabled={props.working === "logout-all"}>{props.working === "logout-all" ? "Closing…" : "Log out all"}</button></div>
          <div className="settings-action-row"><div><strong>Sign out here</strong><span>End this browser session only.</span></div><button className="button button-subtle" onClick={props.onLogout}><LogOut size={14} />Sign out</button></div>
        </section>
      </div>
      <div className="settings-side">
        <section className="card settings-aside-card">
          <span className="aside-shield"><ShieldCheck size={21} /></span><span className="section-kicker">PRIVACY GUARANTEES</span><h2>Your account stays in control.</h2>
          <ul><li><Check size={14} />Explicit browser location permission</li><li><Check size={14} />AES-GCM encrypted location points</li><li><Check size={14} />Automatic point deletion by retention window</li><li><Check size={14} />No phone-number or email location lookup</li><li><Check size={14} />Revoke individual viewers or stop all</li></ul>
          <a href="/privacy" className="text-button">Read the Privacy Policy <ChevronRight size={13} /></a>
        </section>
        <section className="card account-delete-card">
          <span className="section-kicker danger-kicker">PERMANENT ACTION</span><h2>Delete your account</h2><p>Removes your profile, devices, invitations, location-sharing sessions, and retained points.</p>
          <form className="form-stack" onSubmit={props.deleteAccount}><label className="field-label">Confirm with your password<input type="password" value={props.accountPassword} onChange={(event) => props.setAccountPassword(event.target.value)} autoComplete="current-password" required /></label><button className="button button-danger-outline full-button" disabled={props.working === "delete-account"}><Trash2 size={14} />Delete my account</button></form>
        </section>
      </div>
    </div>
  );
}
