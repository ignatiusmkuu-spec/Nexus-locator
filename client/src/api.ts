export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

let csrfToken = "";
let csrfLoad: Promise<string> | null = null;

async function fetchCsrf() {
  if (!csrfLoad) {
    csrfLoad = fetch("/api/auth/csrf", { credentials: "same-origin" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new ApiError(data.error ?? "Could not start a secure session.", response.status);
        csrfToken = data.csrfToken;
        return csrfToken;
      })
      .finally(() => { csrfLoad = null; });
  }
  return csrfLoad;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    if (!csrfToken) await fetchCsrf();
    headers.set("X-CSRF-Token", csrfToken);
  }
  const response = await fetch(path, { ...options, method, headers, credentials: "same-origin" });
  let data: any = {};
  try { data = await response.json(); } catch { /* A non-JSON failure gets a clear generic message below. */ }
  if (typeof data.csrfToken === "string") csrfToken = data.csrfToken;
  if (!response.ok) throw new ApiError(data.error ?? "The request could not be completed.", response.status);
  return data as T;
}

export function setCsrf(token: string) {
  csrfToken = token;
}

export function clearCsrf() {
  csrfToken = "";
}

export type CurrentUser = {
  id: string;
  email: string;
  displayName: string;
  role: "member" | "admin" | string;
  createdAt: string;
};

export type Device = {
  id: string;
  display_name: string;
  device_type: string;
  operating_system: string;
  browser: string;
  screen_info: string | null;
  battery_percent: number | null;
  connection_type: string | null;
  last_seen: string | null;
  created_at: string;
  online: boolean;
};

export type LocationPoint = {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number | null;
  heading: number | null;
  speed: number | null;
  recorded_at?: string;
  recordedAt?: string;
};

export type Share = {
  id: string;
  device_id: string;
  owner_id: string;
  viewer_id: string;
  started_at: string;
  stopped_at: string | null;
  stop_reason: string | null;
  owner_name: string;
  viewer_name: string;
  device_name: string;
  device_type: string;
  operating_system: string;
  browser: string;
  battery_percent: number | null;
  connection_type: string | null;
  last_seen: string | null;
  device_online: boolean;
  revoked_at: string | null;
  last_access_at: string | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
  altitude?: number | null;
  heading?: number | null;
  speed?: number | null;
  recorded_at?: string | null;
};
