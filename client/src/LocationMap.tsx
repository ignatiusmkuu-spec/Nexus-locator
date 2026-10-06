import { useEffect } from "react";
import { Circle, MapContainer, Marker, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import { Crosshair, LocateFixed, Map as MapIcon } from "lucide-react";
import type { LocationPoint, Share } from "./api";

function Recenter({ point }: { point: LocationPoint }) {
  const map = useMap();
  useEffect(() => {
    map.panTo([point.latitude, point.longitude], { animate: true, duration: 0.6 });
  }, [point.latitude, point.longitude, map]);
  return null;
}

const locationMarker = L.divIcon({
  className: "location-marker",
  html: '<span class="location-marker-ring"><span class="location-marker-core"></span></span>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

export default function LocationMap({ share }: { share: Share | null }) {
  const hasLocation = share?.latitude != null && share.longitude != null;
  if (!hasLocation) {
    return (
      <div className="map-empty">
        <div className="map-empty-visual"><MapIcon size={23} /><span /><span /></div>
        <strong>No authorized location yet</strong>
        <p>When a device owner approves sharing and grants location permission, their real location will appear here.</p>
        <span className="map-empty-note"><Crosshair size={13} /> No coordinates are simulated</span>
      </div>
    );
  }

  const point = share as Share & LocationPoint;
  const timestamp = point.recorded_at ? new Date(point.recorded_at) : null;
  const stale = !share.device_online || !timestamp || Date.now() - timestamp.getTime() > 60_000;
  const zoom = point.accuracy < 75 ? 16 : point.accuracy < 400 ? 14 : 12;
  return (
    <div className="map-frame">
      <div className="map-status-row">
        <span className={`live-pill ${stale ? "is-stale" : ""}`}><i />{stale ? "LAST KNOWN" : "LIVE LOCATION"}</span>
        <span className="map-updated">{timestamp ? `Updated ${formatTimeAgo(timestamp)}` : "No timestamp"}</span>
      </div>
      <MapContainer
        className="location-leaflet"
        center={[point.latitude, point.longitude]}
        zoom={zoom}
        scrollWheelZoom
        zoomControl
        attributionControl
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
        />
        <Recenter point={point} />
        <Circle
          center={[point.latitude, point.longitude]}
          radius={point.accuracy}
          pathOptions={{ color: "#ff4059", fillColor: "#ff4059", fillOpacity: 0.12, weight: 1.5 }}
        />
        <Marker position={[point.latitude, point.longitude]} icon={locationMarker} />
      </MapContainer>
      <div className="map-location-chip"><LocateFixed size={14} /><span>± {Math.round(point.accuracy)} m accuracy</span></div>
    </div>
  );
}

export function formatTimeAgo(date: Date) {
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 8) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString();
}
