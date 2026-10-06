import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Activity, ArrowRight, Eye, EyeOff, Fingerprint, LockKeyhole, MapPin, ShieldCheck } from "lucide-react";
import { api, setCsrf, type CurrentUser } from "./api";
import Dashboard from "./Dashboard";
import InvitationPage from "./InvitationPage";

export default function App() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [ready, setReady] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    api<{ user: CurrentUser | null; csrfToken: string }>("/api/auth/session")
      .then((result) => {
        setCsrf(result.csrfToken);
        setUser(result.user);
      })
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, [location.pathname]);

  const onAuth = (nextUser: CurrentUser) => {
    setUser(nextUser);
    const params = new URLSearchParams(location.search);
    const requested = params.get("next");
    const destination = requested?.startsWith("/") && !requested.startsWith("//") ? requested : "/";
    navigate(destination, { replace: true });
  };

  const logOut = () => {
    setUser(null);
    navigate("/login", { replace: true });
  };

  if (!ready) {
    return <div className="loading-screen"><span className="loader-orbit" /><p>Securing your session…</p></div>;
  }

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <AuthPage onAuth={onAuth} mode="login" />} />
      <Route path="/signup" element={user ? <Navigate to="/" replace /> : <AuthPage onAuth={onAuth} mode="signup" />} />
      <Route path="/invite/:token" element={<InvitationPage user={user} />} />
      <Route path="/terms" element={<LegalPage kind="terms" />} />
      <Route path="/privacy" element={<LegalPage kind="privacy" />} />
      <Route path="*" element={user ? <Dashboard user={user} onUserChange={setUser} onLogout={logOut} /> : <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />} />
    </Routes>
  );
}

function Brand() {
  return (
    <div className="brand-lockup">
      <div className="brand-mark"><Fingerprint size={22} strokeWidth={1.8} /></div>
      <div><strong>NEXUS</strong><span>LOCATOR</span></div>
    </div>
  );
}

function AuthPage({ mode, onAuth }: { mode: "login" | "signup"; onAuth: (user: CurrentUser) => void }) {
  const [searchParams] = useSearchParams();
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const isSignup = mode === "signup";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await api<{ user: CurrentUser; csrfToken: string }>(`/api/auth/${isSignup ? "signup" : "login"}`, {
        method: "POST",
        body: JSON.stringify(isSignup ? { email, displayName, password } : { email, password }),
      });
      setCsrf(result.csrfToken);
      onAuth(result.user);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Your account could not be opened.");
    } finally {
      setBusy(false);
    }
  }

  const next = searchParams.get("next");
  const switchPath = isSignup ? "/login" : "/signup";
  const switchLink = next ? `${switchPath}?next=${encodeURIComponent(next)}` : switchPath;

  return (
    <main className="auth-page">
      <div className="auth-glow auth-glow-red" /><div className="auth-glow auth-glow-blue" />
      <header className="auth-topbar"><Brand /><span className="secure-tag"><LockKeyhole size={13} /> PRIVATE BY DESIGN</span></header>
      <div className="auth-layout">
        <section className="auth-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> LOCATION, BY CONSENT</div>
          <h1>Your people.<br /><span>Your permission.</span></h1>
          <p className="auth-lede">A private place to share a device’s location in real time—with the owner’s clear approval, and control that stays in their hands.</p>
          <div className="auth-principles">
            <div><ShieldCheck size={17} /><span>Permission on the device, every time</span></div>
            <div><Fingerprint size={17} /><span>Encrypted location data, short retention</span></div>
            <div><Activity size={17} /><span>Stop sharing instantly, from either side</span></div>
          </div>
          <div className="notice-banner"><span className="notice-dot" /><p>A phone number or email address cannot independently reveal someone’s GPS location.</p></div>
        </section>

        <section className="auth-card">
          <div className="auth-card-heading">
            <div className="auth-icon"><MapPin size={18} /></div>
            <div><span className="section-kicker">{isSignup ? "GET STARTED" : "WELCOME BACK"}</span><h2>{isSignup ? "Create your account" : "Sign in to Nexus"}</h2></div>
          </div>
          <form onSubmit={submit} className="form-stack">
            {isSignup && <label className="field-label">Full name<input autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your name" minLength={1} maxLength={80} required /></label>}
            <label className="field-label">Email address<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" maxLength={320} required /></label>
            <label className="field-label">Password
              <span className="password-wrap"><input type={showPassword ? "text" : "password"} autoComplete={isSignup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={isSignup ? "At least 10 characters" : "Enter your password"} minLength={isSignup ? 10 : 1} maxLength={128} required /><button type="button" className="password-toggle" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></span>
            </label>
            {error && <div className="inline-error" role="alert">{error}</div>}
            <button type="submit" className="button button-primary auth-submit" disabled={busy}>{busy ? "Please wait…" : isSignup ? "Create account" : "Sign in"}<ArrowRight size={16} /></button>
          </form>
          <p className="auth-switch">{isSignup ? "Already have an account?" : "New to Nexus Locator?"} <a href={switchLink}>{isSignup ? "Sign in" : "Create an account"}</a></p>
          <div className="auth-legal">By continuing, you agree to our <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</div>
        </section>
      </div>
      <footer className="auth-footer"><span>© {new Date().getFullYear()} Nexus Locator</span><span><a href="/terms">Terms</a><a href="/privacy">Privacy</a><span className="footer-live-dot" /> NO LOCATION WITHOUT CONSENT</span></footer>
    </main>
  );
}

function LegalPage({ kind }: { kind: "terms" | "privacy" }) {
  const isTerms = kind === "terms";
  return (
    <main className="legal-page">
      <header className="legal-topbar"><Brand /><a href="/" className="text-link">Return to Nexus</a></header>
      <article className="legal-content">
        <span className="section-kicker">NEXUS LOCATOR · {isTerms ? "TERMS OF SERVICE" : "PRIVACY POLICY"}</span>
        <h1>{isTerms ? "Terms of Service" : "Privacy Policy"}</h1>
        <p className="legal-updated">Last updated: October 2026</p>
        <div className="legal-callout"><ShieldCheck size={17} /><p>Location sharing requires the device owner’s permission. A phone number or email address cannot independently reveal a person’s GPS location.</p></div>
        {isTerms ? <TermsText /> : <PrivacyText />}
        <p className="legal-disclaimer">These pages describe this application’s current technical behavior. They are not legal advice and should be reviewed by qualified counsel before public launch.</p>
      </article>
    </main>
  );
}

function TermsText() {
  return <div className="legal-sections">
    <section><h2>1. Consent and permitted use</h2><p>Use Nexus Locator only for lawful, consensual location sharing. A device owner must sign in, choose to share, and approve the browser’s location permission. You may not use this service to secretly monitor anyone, coerce consent, or evade a device’s operating-system controls.</p></section>
    <section><h2>2. Invitations</h2><p>An invitation is a time-limited link, not a location lookup. The invited device owner must authenticate, review the request, and approve location sharing on the device they choose to share. The inviter is responsible for sending the link to its intended recipient and revoking unused links.</p></section>
    <section><h2>3. Your account and security</h2><p>Keep your account credentials private. You are responsible for activity under your account. You may log out all sessions, change your password, or delete your account in Settings. Do not share your login or pairing code.</p></section>
    <section><h2>4. Availability and location accuracy</h2><p>Location accuracy depends on the device, browser, operating system, network, and permission settings. Location can be delayed or unavailable. Nexus Locator does not promise emergency-service accuracy, continuous background tracking, or uninterrupted availability.</p></section>
    <section><h2>5. Suspension and reports</h2><p>We may revoke sharing or restrict an account to address abuse, security risks, or unlawful activity. Use the in-app report form to flag suspected misuse.</p></section>
    <section><h2>6. Changes</h2><p>These terms may be updated as the service changes. Continued use after a posted change indicates acceptance of the revised terms.</p></section>
  </div>;
}

function PrivacyText() {
  return <div className="legal-sections">
    <section><h2>1. Information collected</h2><p>Account email, display name, and password hash; browser-reported device metadata; invitation targets you enter; consent/sharing events; and precise location details only after the device owner starts sharing and grants browser permission.</p><p>Location is obtained from the browser’s Geolocation API. Phone numbers, email addresses, IP addresses, and usernames are never used to infer or look up a location. Battery and network details are collected only when the browser exposes them.</p></section>
    <section><h2>2. Why we use it</h2><p>Account details authenticate users; device details help identify registered devices; invitations request consent; location points update maps for the device owner and authorized viewer; security logs record sharing starts, stops, access, and revocations.</p></section>
    <section><h2>3. Who can access location</h2><p>The device owner and the specific account approved to view an active sharing session may access its location. Location payloads are encrypted before database storage. Platform administrators can manage account/device metadata and revoke sharing but do not receive precise coordinates or location history through administrator tools.</p></section>
    <section><h2>4. Retention and deletion</h2><p>Precise location points expire automatically after 24 hours by default. The operator can configure a retention period from 1 to 720 hours. Users can delete their retained location points, stop all sharing, revoke individual access, or delete their account and linked devices, sessions, invitations, and location points.</p></section>
    <section><h2>5. Service providers</h2><p>OpenStreetMap tiles provide map imagery and are subject to the OpenStreetMap tile usage policy. This app does not perform address geocoding. Replit PostgreSQL stores application records. Invitation links are created in the app but are not automatically emailed or texted; the user shares the link directly.</p></section>
    <section><h2>6. Security and requests</h2><p>Sessions use HTTP-only cookies; sensitive changes require a CSRF token. Location points use authenticated encryption and short retention. This release does not provide email verification, SMS OTP delivery, or a privacy-request intake workflow. Use account deletion to remove your account data.</p></section>
  </div>;
}
