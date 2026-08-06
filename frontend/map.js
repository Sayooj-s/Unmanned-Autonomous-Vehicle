const API_BASE = "";
const POLL_MS = 3000;

let map;
let markers = {};      // uav_id -> Leaflet marker
let firstFix = true;

function initMap() {
  map = L.map("map", { zoomControl: true, attributionControl: true })
    .setView([20.5937, 78.9629], 4); // neutral default view until real data arrives

  // Dark basemap to match the dashboard theme
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; OpenStreetMap contributors',
    subdomains: "abcd",
    maxZoom: 19,
  }).addTo(map);
}

function droneIcon() {
  return L.divIcon({
    className: "",
    html: '<div class="drone-marker"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    popupAnchor: [0, -8],
  });
}

function popupContent(u, latest) {
  const time = latest && latest.timestamp ? new Date(latest.timestamp).toLocaleTimeString() : "—";
  const alt = latest && latest.altitude !== null && latest.altitude !== undefined ? latest.altitude.toFixed(1) : "—";
  const lat = latest && latest.latitude !== null && latest.latitude !== undefined ? latest.latitude.toFixed(6) : "—";
  const lon = latest && latest.longitude !== null && latest.longitude !== undefined ? latest.longitude.toFixed(6) : "—";
  return `
    <div class="popup-title">${u.name || u.uav_id}</div>
    <div>Lat: ${lat}</div>
    <div>Lon: ${lon}</div>
    <div>Alt: ${alt} m</div>
    <div>Updated: ${time}</div>
  `;
}

function renderOverlay(uavs) {
  const list = document.getElementById("fleetOverlayList");
  if (uavs.length === 0) {
    list.innerHTML = `<div class="overlay-uav"><span class="overlay-uav-meta">No UAVs registered yet.</span></div>`;
    return;
  }
  list.innerHTML = uavs.map(u => {
    const latest = u.latest;
    const hasGps = latest && latest.latitude !== null && latest.latitude !== undefined
                        && latest.longitude !== null && latest.longitude !== undefined;
    return `
      <div class="overlay-uav" data-id="${u.uav_id}">
        <div class="overlay-uav-name">${u.name || u.uav_id}</div>
        <div class="overlay-uav-meta">
          ${hasGps
            ? `Alt ${latest.altitude !== null && latest.altitude !== undefined ? latest.altitude.toFixed(1) : "—"} m`
            : `<span class="no-gps">No GPS fix yet</span>`}
        </div>
      </div>
    `;
  }).join("");

  list.querySelectorAll(".overlay-uav[data-id]").forEach(el => {
    el.addEventListener("click", () => {
      const marker = markers[el.dataset.id];
      if (marker) {
        map.setView(marker.getLatLng(), 16);
        marker.openPopup();
      }
    });
  });
}

async function refreshMap() {
  try {
    const res = await fetch(API_BASE + "/api/uavs");
    if (!res.ok) throw new Error(res.statusText);
    const uavs = await res.json();

    setLinkStatus(true);
    renderOverlay(uavs);

    const validPoints = [];

    uavs.forEach(u => {
      const latest = u.latest;
      const hasGps = latest && latest.latitude !== null && latest.latitude !== undefined
                          && latest.longitude !== null && latest.longitude !== undefined;
      if (!hasGps) return;

      const latlng = [latest.latitude, latest.longitude];
      validPoints.push(latlng);

      if (markers[u.uav_id]) {
        markers[u.uav_id].setLatLng(latlng);
        markers[u.uav_id].setPopupContent(popupContent(u, latest));
      } else {
        const marker = L.marker(latlng, { icon: droneIcon() })
          .addTo(map)
          .bindPopup(popupContent(u, latest));
        markers[u.uav_id] = marker;
      }
    });

    if (firstFix && validPoints.length > 0) {
      if (validPoints.length === 1) {
        map.setView(validPoints[0], 16);
      } else {
        map.fitBounds(validPoints, { padding: [60, 60] });
      }
      firstFix = false;
    }
  } catch (e) {
    console.error("Failed to reach backend:", e);
    setLinkStatus(false);
  }
}

function setLinkStatus(online) {
  const dot = document.getElementById("pulseDot");
  const label = document.getElementById("linkLabel");
  if (online) {
    dot.classList.remove("offline");
    label.classList.remove("offline");
    label.textContent = "LIVE";
  } else {
    dot.classList.add("offline");
    label.classList.add("offline");
    label.textContent = "OFFLINE";
  }
}

initMap();
refreshMap();
setInterval(refreshMap, POLL_MS);
