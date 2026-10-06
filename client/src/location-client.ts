import { api, type LocationPoint } from "./api";

const DEVICE_ID_KEY = "nexus.current-device";

export function getStoredDeviceId() {
  try { return localStorage.getItem(DEVICE_ID_KEY) ?? undefined; } catch { return undefined; }
}

export function storeDeviceId(id: string) {
  try { localStorage.setItem(DEVICE_ID_KEY, id); } catch { /* The server-side registration remains available. */ }
}

function identifyDevice() {
  const ua = navigator.userAgent;
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean; platform?: string }; connection?: { effectiveType?: string; type?: string } };
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Other";
  const operatingSystem = nav.userAgentData?.platform || (/Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Unknown");
  const isMobile = nav.userAgentData?.mobile ?? /Android|iPhone|iPod|Mobile/i.test(ua);
  const deviceType = isMobile ? "mobile" : /iPad|Tablet/i.test(ua) ? "tablet" : "desktop";
  const connectionType = nav.connection?.effectiveType
    ? `Approx. ${nav.connection.effectiveType}`
    : nav.connection?.type
      ? `Approx. ${nav.connection.type}`
      : null;
  return {
    displayName: `${operatingSystem} ${deviceType === "mobile" ? "phone" : deviceType === "tablet" ? "tablet" : "computer"}`,
    deviceType,
    operatingSystem,
    browser,
    screenInfo: typeof screen !== "undefined" ? `${screen.width} × ${screen.height}` : null,
    batteryPercent: null as number | null,
    connectionType,
  };
}

export async function collectDeviceInfo() {
  const info = identifyDevice();
  const batteryNavigator = navigator as Navigator & { getBattery?: () => Promise<{ level: number }> };
  if (batteryNavigator.getBattery) {
    try {
      const battery = await batteryNavigator.getBattery();
      info.batteryPercent = Math.max(0, Math.min(100, Math.round(battery.level * 100)));
    } catch { /* Browser refused access; report not available. */ }
  }
  return info;
}

export type PreparedPoint = LocationPoint & { updateKey: string };

function pointFromPosition(position: GeolocationPosition): PreparedPoint {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy: position.coords.accuracy,
    altitude: position.coords.altitude,
    heading: position.coords.heading,
    speed: position.coords.speed,
    updateKey: crypto.randomUUID(),
  };
}

export function getCurrentPosition(): Promise<PreparedPoint> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("This browser does not provide location access."));
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(pointFromPosition(position)),
      (error) => {
        if (error.code === error.PERMISSION_DENIED) return reject(new Error("Location permission was denied. No location was shared."));
        if (error.code === error.TIMEOUT) return reject(new Error("The device did not provide a location in time. Nothing was shared."));
        reject(new Error("The device could not determine a location. Check GPS/location services and try again."));
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    );
  });
}

const watchers = new Map<string, number>();
const lastSentAt = new Map<string, number>();

export function stopLocationWatch(deviceId: string) {
  const watcher = watchers.get(deviceId);
  if (watcher !== undefined && navigator.geolocation) navigator.geolocation.clearWatch(watcher);
  watchers.delete(deviceId);
  lastSentAt.delete(deviceId);
}

export function watchApprovedDevice(deviceId: string, onError: (message: string) => void) {
  if (!navigator.geolocation || watchers.has(deviceId)) return;
  const watcher = navigator.geolocation.watchPosition(async (position) => {
    const now = Date.now();
    if (now - (lastSentAt.get(deviceId) ?? 0) < 5_000) return;
    lastSentAt.set(deviceId, now);
    try {
      await api(`/api/devices/${deviceId}/location`, {
        method: "POST",
        body: JSON.stringify(pointFromPosition(position)),
      });
    } catch (error) {
      if (error instanceof Error && "status" in error && (error as any).status === 403) {
        stopLocationWatch(deviceId);
        onError("Sharing was stopped or revoked, so this device is no longer sending locations.");
      } else {
        onError(error instanceof Error ? error.message : "Location update could not be sent.");
      }
    }
  }, (error) => {
    if (error.code === error.PERMISSION_DENIED) {
      stopLocationWatch(deviceId);
      onError("Location permission was removed in browser settings. Sharing is paused.");
    } else if (error.code === error.POSITION_UNAVAILABLE) {
      onError("Location is temporarily unavailable. The last authorized location remains visible until it expires.");
    } else {
      onError("Location update timed out. The app will keep trying while sharing remains active.");
    }
  }, { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 });
  watchers.set(deviceId, watcher);
}

