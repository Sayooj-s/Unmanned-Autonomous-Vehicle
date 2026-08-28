/**
 * Digital Twin — 3D flight view.
 *
 * Renders a real-world 3D map (OpenStreetMap buildings + real elevation
 * terrain, both free/no-key data sources) and flies a drone marker through
 * it using the UAV's actual GPS + altitude telemetry. A chase camera
 * follows the drone; altitude is represented as a vertical "lift" above
 * the ground point since browser maps are 2.5D, not a true 3D engine.
 */

const API_BASE = window.API_BASE || "";
const FLEET_POLL_MS = 3000;
const TWIN_POLL_MS = 1500;
const TRAIL_LIMIT = 60;

// Free, no-API-key basemap + terrain sources.
const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const TERRAIN_TILES = ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"];

let selectedUavId = null;
let lastFleetPayload = [];
let twinTimer = null;

let map = null;
let mapReady = false;
let droneMarker = null;
let homeMarker = null;
let pendingHome = null; // [lng, lat] for the selected UAV's first GPS fix, if known
let followEnabled = true;
let lastLngLat = null; // for bearing calculation

// ---------- Networking ----------

async function fetchJSON(path) {
  const res = await fetch(API_BASE + path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function setLinkStatus(online) {
  const dot = document.getElementById("pulseDot");
  const label = document.getElementById("linkLabel");
  const last = document.getElementById("lastUpdate");
  if (online) {
    dot.classList.remove("offline");
    label.classList.remove("offline");
    label.textContent = "ARMED";
    last.textContent = new Date().toLocaleTimeString();
  } else {
    dot.classList.add("offline");
    label.classList.add("offline");
    label.textContent = "DISARMED";
  }
}

// ---------- Fleet list (left rail) ----------

function renderFleetList(uavs) {
  const list = document.getElementById("fleetList");
  const empty = document.getElementById("fleetEmpty");
  const count = document.getElementById("fleetCount");
  count.textContent = uavs.length;

  if (uavs.length === 0) {
    list.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  list.innerHTML = uavs.map(u => {
    const latest = u.latest;
    const soc = latest ? latest.soc : null;
    const alertLevel = u.alert ? u.alert.level : "ok";
    const cls = alertLevel === "critical" ? "crit" : alertLevel === "warning" ? "warn" : "ok";
    const active = u.uav_id === selectedUavId ? "active" : "";
    const cmdTag = (u.pending_command && u.pending_command !== "NONE")
      ? `<span class="crit">${u.pending_command}</span>` : "";
    return `
      <div class="uav-card ${active}" data-id="${u.uav_id}">
        <div class="uav-card-top">
          <span class="uav-card-name">${u.name || u.uav_id}</span>
        </div>
        <div class="uav-card-id">${u.uav_id}</div>
        <div class="uav-card-meta">
          <span class="${cls}">SoC ${soc !== null && soc !== undefined ? soc.toFixed(0) + "%" : "—"}</span>
          <span>${latest ? new Date(latest.timestamp).toLocaleTimeString() : "no data"}</span>
          ${cmdTag}
        </div>
      </div>
    `;
  }).join("");

  list.querySelectorAll(".uav-card").forEach(card => {
    card.addEventListener("click", () => selectUav(card.dataset.id));
  });
}

function selectUav(uavId) {
  const changed = uavId !== selectedUavId;
  selectedUavId = uavId;
  renderFleetList(lastFleetPayload);

  document.getElementById("noSelection").style.display = "none";
  document.getElementById("twinContent").style.display = "flex";

  const uav = lastFleetPayload.find(u => u.uav_id === uavId);
  document.getElementById("twinName").textContent = (uav && uav.name) || uavId;
  document.getElementById("twinId").textContent = uavId;

  ensure3DMap();
  if (changed) {
    lastLngLat = null; // reset bearing tracking for the newly selected UAV
    if (homeMarker) { homeMarker.remove(); homeMarker = null; }
    pendingHome = (uav && uav.home_lat !== undefined && uav.home_lat !== null
                       && uav.home_lon !== undefined && uav.home_lon !== null)
      ? [uav.home_lon, uav.home_lat] : null;
  }
  clearInterval(twinTimer);
  pollTwin();
  twinTimer = setInterval(pollTwin, TWIN_POLL_MS);
}

async function refreshFleet() {
  try {
    const uavs = await fetchJSON("/api/uavs");
    lastFleetPayload = uavs;
    renderFleetList(uavs);
    setLinkStatus(Array.isArray(uavs) && uavs.some(u => u.is_active));
  } catch (e) {
    console.error("Failed to reach backend:", e);
    setLinkStatus(false);
  }
}

// ---------- HUD + alert readout ----------

function setChip(id, value, decimals, warnAt, critAt, higherIsWorse = true) {
  const el = document.getElementById(id);
  const chip = el.closest(".hud-chip");
  el.textContent = (value === null || value === undefined) ? "—" : Number(value).toFixed(decimals);
  chip.classList.remove("warn", "crit");
  if (value === null || value === undefined || warnAt === undefined) return;
  const bad = higherIsWorse ? value >= critAt : value <= critAt;
  const meh = higherIsWorse ? value >= warnAt : value <= warnAt;
  if (bad) chip.classList.add("crit");
  else if (meh) chip.classList.add("warn");
}

function renderTwinAlert(alert, pendingCommand) {
  const banner = document.getElementById("twinAlertBanner");
  if (!alert || alert.level === "ok" || alert.level === "unknown" || !alert.reasons || alert.reasons.length === 0) {
    banner.style.display = "none";
    return;
  }
  banner.style.display = "flex";
  banner.classList.toggle("critical", alert.level === "critical");
  document.getElementById("twinAlertTitle").textContent =
    alert.level === "critical" ? "CRITICAL — action recommended" : "WARNING";
  document.getElementById("twinAlertReasons").innerHTML =
    alert.reasons.map(r => `<li>${r}</li>`).join("");
  document.getElementById("twinAlertCommand").textContent =
    pendingCommand && pendingCommand !== "NONE" ? `COMMAND: ${pendingCommand}` : "";
}

async function pollTwin() {
  if (!selectedUavId) return;
  try {
    const latest = await fetchJSON(`/api/uavs/${encodeURIComponent(selectedUavId)}/latest`);
    const uav = lastFleetPayload.find(u => u.uav_id === selectedUavId);

    setChip("twinSoc", latest.soc, 0, 35, 20, false);
    setChip("twinAlt", latest.altitude, 1);
    setChip("twinTemp", latest.temperature, 1, 50, 60);
    setChip("twinCurrent", latest.current, 2);
    setChip("twinVib", latest.vibration_rms, 3, 0.20, 0.30);
    setChip("twinVolt", latest.battery_voltage, 2);

    document.getElementById("twinUpdated").textContent =
      latest.timestamp ? new Date(latest.timestamp).toLocaleTimeString() : "—";

    renderTwinAlert(latest.alert, uav ? uav.pending_command : "NONE");
    updateMapForReading(latest);

    // Trail: light-weight history fetch, only lat/lon/timestamp matter here.
    try {
      const rows = await fetchJSON(`/api/uavs/${encodeURIComponent(selectedUavId)}/telemetry?limit=${TRAIL_LIMIT}`);
      updateTrail(rows);
    } catch (e) {
      // Trail is a nice-to-have; don't let it block the rest of the HUD.
    }
  } catch (e) {
    updateMapForReading(null);
  }
}

// ---------- 3D map ----------

function ensure3DMap() {
  if (map || typeof maplibregl === "undefined") return;

  map = new maplibregl.Map({
    container: "twin3dMap",
    style: MAP_STYLE,
    center: [78.9629, 20.5937], // neutral default until a GPS fix arrives
    zoom: 4,
    pitch: 60,
    bearing: 0,
    attributionControl: true,
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

  map.on("load", () => {
    try {
      map.addSource("terrain-dem", {
        type: "raster-dem",
        tiles: TERRAIN_TILES,
        tileSize: 256,
        encoding: "terrarium",
        maxzoom: 15,
      });
      map.setTerrain({ source: "terrain-dem", exaggeration: 1.4 });
    } catch (e) {
      console.warn("Terrain unavailable, continuing with a flat basemap:", e);
    }

    try {
      map.addLayer({ id: "sky", type: "sky", paint: { "sky-type": "atmosphere" } });
    } catch (e) {
      // Older MapLibre builds may not support the sky layer — purely cosmetic.
    }

    map.addSource("flight-trail", {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } },
    });
    map.addLayer({
      id: "flight-trail-line",
      type: "line",
      source: "flight-trail",
      paint: {
        "line-color": "#5ec8d8",
        "line-width": 3,
        "line-opacity": 0.75,
      },
      layout: { "line-cap": "round", "line-join": "round" },
    });

    mapReady = true;
  });

  document.getElementById("followBtn").addEventListener("click", () => {
    followEnabled = !followEnabled;
    const btn = document.getElementById("followBtn");
    const label = document.getElementById("followLabel");
    btn.classList.toggle("off", !followEnabled);
    label.textContent = followEnabled ? "FOLLOW: ON" : "FOLLOW: OFF";
  });
}

function droneIconHTML(alertLevel) {
  const cls = alertLevel === "critical" ? "crit" : alertLevel === "warning" ? "warn" : "";
  return `
    <svg class="drone3d-icon ${cls}" viewBox="0 0 36 36" width="34" height="34" xmlns="http://www.w3.org/2000/svg">
      <line x1="8" y1="8" x2="28" y2="28" class="drone-arm" />
      <line x1="28" y1="8" x2="8" y2="28" class="drone-arm" />
      <circle cx="8" cy="8" r="5" class="drone-rotor" />
      <circle cx="28" cy="8" r="5" class="drone-rotor" />
      <circle cx="8" cy="28" r="5" class="drone-rotor" />
      <circle cx="28" cy="28" r="5" class="drone-rotor" />
      <circle cx="18" cy="18" r="6" class="drone-body" />
    </svg>
  `;
}

function bearingBetween(a, b) {
  // a, b: [lng, lat] — returns compass bearing in degrees from a to b.
  const toRad = d => (d * Math.PI) / 180;
  const toDeg = r => (r * 180) / Math.PI;
  const lat1 = toRad(a[1]), lat2 = toRad(b[1]);
  const dLon = toRad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function ensureDroneMarker(alertLevel) {
  if (droneMarker) return droneMarker;

  const el = document.createElement("div");
  el.className = "drone3d-marker";
  el.innerHTML = `
    ${droneIconHTML(alertLevel)}
    <div class="drone3d-tether" style="height:0px;"></div>
    <div class="drone3d-shadow"></div>
  `;

  droneMarker = new maplibregl.Marker({ element: el, anchor: "bottom" });
  return droneMarker;
}

/** Rough, deliberately simple altitude → on-screen lift in pixels. Real
 * meters-to-pixels depends on zoom/latitude; this is a game-like
 * approximation so higher readings visibly float further above the
 * ground point rather than trying to be geodetically exact. */
function liftPixelsForAltitude(altitudeMeters) {
  const alt = Math.max(0, altitudeMeters || 0);
  return Math.min(alt * 2.2, 220);
}

function updateMapForReading(latest) {
  const overlay = document.getElementById("noGpsOverlay");
  const hasGps = latest && latest.latitude !== null && latest.latitude !== undefined
                       && latest.longitude !== null && latest.longitude !== undefined;

  if (!hasGps) {
    overlay.style.display = "flex";
    if (droneMarker) droneMarker.remove();
    return;
  }
  overlay.style.display = "none";
  if (!mapReady) return;

  if (pendingHome) {
    if (!homeMarker) {
      const el = document.createElement("div");
      el.className = "home-marker";
      homeMarker = new maplibregl.Marker({ element: el, anchor: "center" });
    }
    homeMarker.setLngLat(pendingHome);
    if (!homeMarker._map) homeMarker.addTo(map);
  }

  const lngLat = [latest.longitude, latest.latitude];
  const alertLevel = latest.alert ? latest.alert.level : "ok";

  const marker = ensureDroneMarker(alertLevel);
  const el = marker.getElement();
  const svg = el.querySelector(".drone3d-icon");
  svg.classList.remove("crit", "warn");
  if (alertLevel === "critical") svg.classList.add("crit");
  else if (alertLevel === "warning") svg.classList.add("warn");
  el.querySelector(".drone3d-tether").style.height = `${liftPixelsForAltitude(latest.altitude)}px`;

  marker.setLngLat(lngLat);
  if (!marker._map) marker.addTo(map);

  let bearing = map.getBearing();
  if (lastLngLat) {
    const dist = Math.hypot(lngLat[0] - lastLngLat[0], lngLat[1] - lastLngLat[1]);
    if (dist > 1e-6) bearing = bearingBetween(lastLngLat, lngLat);
  }
  lastLngLat = lngLat;

  if (followEnabled) {
    map.easeTo({
      center: lngLat,
      bearing,
      pitch: 60,
      zoom: Math.max(map.getZoom(), 17),
      duration: TWIN_POLL_MS * 0.9,
      easing: t => t,
    });
  }
}

function updateTrail(rows) {
  if (!mapReady) return;
  const src = map.getSource("flight-trail");
  if (!src) return;
  const coords = rows
    .filter(r => r.latitude !== null && r.latitude !== undefined && r.longitude !== null && r.longitude !== undefined)
    .map(r => [r.longitude, r.latitude]);
  src.setData({ type: "Feature", geometry: { type: "LineString", coordinates: coords } });
}

// ---------- Boot ----------

refreshFleet();
setInterval(refreshFleet, FLEET_POLL_MS);
