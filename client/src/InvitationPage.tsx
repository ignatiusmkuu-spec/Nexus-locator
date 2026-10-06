import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, Check, Clock3, Fingerprint, Link2, LoaderCircle, MapPin, Shield, X } from "lucide-react";
import { api, type CurrentUser } from "./api";
import { collectDeviceInfo, getCurrentPosition, getStoredDeviceId, storeDeviceId, watchApprovedDevice } from "./location-client";

type Invitation = { id: string; requesterName: string; target: string; expiresAt: string };

export default function InvitationPage({ user }: { user: CurrentUser | null }) {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState<"approved" | "declined" | null>(null);

  useEffect(() => {
    api<{ invitation: Invitation }>(`/api/invitations/${encodeURIComponent(token)}`)
      .then((data) => setInvitation(data.invitation))
      .catch((reason) => setError(reason instanceof Error ? reason.message : "This invitation is unavailable."));
  }, [token]);

  async function approve() {
    setBusy(true);
    setError("");
    try {
      if (!window.isSecureContext && location.hostname !== "localhost") throw new Error("Open this app over HTTPS to approve browser location access.");
      const point = await getCurrentPosition();
      const device = await collectDeviceInfo();
      const result = await api<{ deviceId: string }>(`/api/invitations/${encodeURIComponent(token)}/approve`, {
        method: "POST",
        body: JSON.stringify({ currentDevice: { deviceId: getStoredDeviceId(), device }, point }),
      });
      storeDeviceId(result.deviceId);
      watchApprovedDevice(result.deviceId, setError);
      setFinished("approved");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The request could not be approved.");
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/invitations/${encodeURIComponent(token)}/decline`, { method: "POST", body: "{}" });
      setFinished("declined");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The invitation could not be declined.");
    } finally { setBusy(false); }
  }

  return (
    <main className="invite-page">
      <header className="invite-topbar"><Link className="brand-lockup" to="/"><div className="brand-mark"><Fingerprint size={21} /></div><div><strong>NEXUS</strong><span>LOCATOR</span></div></Link><span className="secure-tag"><Shield size={13} /> SECURE INVITATION</span></header>
      <div className="invite-card">
        <div className={`invite-symbol ${finished === "approved" ? "success-symbol" : finished === "declined" ? "muted-symbol" : ""}`}>
          {finished === "approved" ? <Check size={22} /> : finished === "declined" ? <X size={22} /> : error && !invitation ? <AlertTriangle size={21} /> : <Link2 size={21} />}
        </div>
        <span className="section-kicker">{finished ? "INVITATION UPDATED" : "LOCATION SHARING REQUEST"}</span>
        <h1>{finished === "approved" ? "Sharing is on" : finished === "declined" ? "Request declined" : error && !invitation ? "Invite unavailable" : "You’re in control"}</h1>
        {invitation && !finished && <>
          <p className="invite-intro"><strong>{invitation.requesterName}</strong> has invited a device you control to share its location with them.</p>
          <div className="invite-details">
            <div><span className="invite-detail-icon"><MapPin size={15} /></span><p><strong>Only this device</strong><span>The browser and device you approve on this page.</span></p></div>
            <div><span className="invite-detail-icon"><Clock3 size={15} /></span><p><strong>Time-limited request</strong><span>Expires {new Date(invitation.expiresAt).toLocaleString()}.</span></p></div>
            <div><span className="invite-detail-icon"><Shield size={15} /></span><p><strong>Stop whenever you want</strong><span>Sharing can be stopped here or from your privacy dashboard.</span></p></div>
          </div>
          {user ? <div className="invite-actions">
            <button className="button button-primary" type="button" onClick={approve} disabled={busy}>{busy ? <><LoaderCircle size={15} className="spin" /> Waiting for permission…</> : "Approve & share this device"}<MapPin size={15} /></button>
            <button className="button button-quiet" type="button" onClick={decline} disabled={busy}>Decline invitation</button>
          </div> : <div className="invite-actions">
            <p className="invite-auth-note">Sign in or create your account first. You can review this request again after signing in.</p>
            <Link className="button button-primary" to={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>Sign in to review<ArrowLeft size={15} className="arrow-right" /></Link>
            <Link className="button button-quiet" to={`/signup?next=${encodeURIComponent(`/invite/${token}`)}`}>Create account</Link>
          </div>}
        </>}
        {finished === "approved" && <><p className="invite-intro">Your browser permission was granted, and your location is now being shared with <strong>{invitation?.requesterName}</strong>. It will update while this browser stays open.</p><div className="approved-state"><span className="live-dot" /> Live sharing enabled on this device</div><Link className="button button-primary invite-home-button" to="/">Open privacy dashboard<ArrowLeft size={15} className="arrow-right" /></Link></>}
        {finished === "declined" && <><p className="invite-intro">No location was shared. This invitation can no longer be used.</p><Link className="button button-quiet invite-home-button" to="/">Return to Nexus</Link></>}
        {error && <div className="inline-error invite-error" role="alert">{error}</div>}
        {!invitation && !error && <div className="invite-loading"><LoaderCircle size={17} className="spin" /> Checking one-time invite…</div>}
        <div className="invite-safety-note"><span className="notice-dot" /> A phone number or email address cannot independently reveal a person’s GPS location.</div>
      </div>
      <footer className="invite-footer"><Link to="/privacy">Privacy policy</Link><span>LOCATION, BY CONSENT</span><Link to="/terms">Terms of service</Link></footer>
    </main>
  );
}
