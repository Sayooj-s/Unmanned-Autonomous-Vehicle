const API_BASE = ""; // same origin (backend serves this frontend)
const POLL_MS = 3000;

let selectedUavId = null;
let charts = {};
let lastFleetPayload = [];

// ---------- Chart setup ----------

const chartDefaults = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 250 },
  interaction: { mode: "index", intersect: false },
  scales: {
    x: {
      ticks: { color: "#6b7680", font: { family: "IBM Plex Mono", size: 10 }, maxTicksLimit: 6 },
      grid: { color: "#1a2026" },
    },
    y: {
      ticks: { color: "#6b7680", font: { family: "IBM Plex Mono", size: 10 } },
      grid: { color: "#1a2026" },
    },
  },
  plugins: {
    legend: {
      labels: { color: "#a7b0b8", font: { family: "Inter", size: 11 }, boxWidth: 10 },
    },
    tooltip: {
      backgroundColor: "#161c22",
      titleColor: "#e8edf0",
      bodyColor: "#e8edf0",
      borderColor: "#232b32",
      borderWidth: 1,
      titleFont: { family: "IBM Plex Mono", size: 11 },
      bodyFont: { family: "IBM Plex Mono", size: 11 },
    },
  },
};

function makeLineChart(canvasId, datasets) {
  const ctx = document.getElementById(canvasId).getContext("2d");
  return new Chart(ctx, {
    type: "line",
    data: { labels: [], datasets },
    options: chartDefaults,
  });
}

function initCharts() {
  charts.battery = makeLineChart("chartBattery", [
    { label: "Voltage (V)", data: [], borderColor: "#5ec8d8", backgroundColor: "transparent", tension: 0.3, pointRadius: 0, yAxisID: "y" },
    { label: "SoC (%)", data: [], borderColor: "#39ff88", backgroundColor: "transparent", tension: 0.3, pointRadius: 0, yAxisID: "y1" },
  ]);
  charts.battery.options.scales.y1 = {
    position: "right",
    ticks: { color: "#6b7680", font: { family: "IBM Plex Mono", size: 10 } },
    grid: { display: false },
  };

  charts.temp = makeLineChart("chartTemp", [
    { label: "Temp (°C)", data: [], borderColor: "#f2b134", backgroundColor: "rgba(242,177,52,0.08)", fill: true, tension: 0.3, pointRadius: 0 },
  ]);

  charts.vibration = makeLineChart("chartVibration", [
    { label: "X", data: [], borderColor: "#5ec8d8", backgroundColor: "transparent", tension: 0.3, pointRadius: 0 },
    { label: "Y", data: [], borderColor: "#f2b134", backgroundColor: "transparent", tension: 0.3, pointRadius: 0 },
    { label: "Z", data: [], borderColor: "#a78bfa", backgroundColor: "transparent", tension: 0.3, pointRadius: 0 },
    { label: "RMS", data: [], borderColor: "#ff4757", backgroundColor: "transparent", tension: 0.3, pointRadius: 0, borderDash: [4, 3] },
  ]);
}

function updateCharts(rows) {
  const labels = rows.map(r => new Date(r.timestamp).toLocaleTimeString());

  charts.battery.data.labels = labels;
  charts.battery.data.datasets[0].data = rows.map(r => r.battery_voltage);
  charts.battery.data.datasets[1].data = rows.map(r => r.soc);
  charts.battery.update();

  charts.temp.data.labels = labels;
  charts.temp.data.datasets[0].data = rows.map(r => r.temperature);
  charts.temp.update();

  charts.vibration.data.labels = labels;
  charts.vibration.data.datasets[0].data = rows.map(r => r.vibration_x);
  charts.vibration.data.datasets[1].data = rows.map(r => r.vibration_y);
  charts.vibration.data.datasets[2].data = rows.map(r => r.vibration_z);
  charts.vibration.data.datasets[3].data = rows.map(r => r.vibration_rms);
  charts.vibration.update();
}

// ---------- Data fetching ----------

async function fetchJSON(path, opts) {
  const res = await fetch(API_BASE + path, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function statusClass(soc) {
  if (soc === null || soc === undefined) return "";
  if (soc < 20) return "crit";
  if (soc < 40) return "warn";
  return "ok";
}

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
    card.addEventListener("click", () => {
      selectedUavId = card.dataset.id;
      renderFleetList(lastFleetPayload); // refresh active state
      loadDetail(selectedUavId);
    });
  });
}

function setStat(id, value, decimals = 1) {
  const el = document.getElementById(id);
  el.textContent = (value === null || value === undefined) ? "—" : Number(value).toFixed(decimals);
}

function renderAlert(alert, pendingCommand) {
  const banner = document.getElementById("alertBanner");
  if (!alert || alert.level === "ok" || alert.level === "unknown" || !alert.reasons || alert.reasons.length === 0) {
    banner.style.display = "none";
    return;
  }
  banner.style.display = "flex";
  banner.classList.toggle("critical", alert.level === "critical");

  document.getElementById("alertTitle").textContent =
    alert.level === "critical" ? "CRITICAL — action recommended" : "WARNING";
  document.getElementById("alertReasons").innerHTML =
    alert.reasons.map(r => `<li>${r}</li>`).join("");
  document.getElementById("alertCommand").textContent =
    pendingCommand && pendingCommand !== "NONE" ? `COMMAND: ${pendingCommand}` : "";
}

async function loadDetail(uavId) {
  document.getElementById("noSelection").style.display = "none";
  document.getElementById("detailContent").style.display = "block";

  const uav = lastFleetPayload.find(u => u.uav_id === uavId);
  document.getElementById("detailName").textContent = (uav && uav.name) || uavId;
  document.getElementById("detailId").textContent = uavId;

  try {
    const rows = await fetchJSON(`/api/uavs/${encodeURIComponent(uavId)}/telemetry?limit=100`);
    if (rows.length > 0) {
      const latest = rows[rows.length - 1];
      setStat("socVal", latest.soc, 0);
      setStat("sohVal", latest.soh, 0);
      setStat("voltVal", latest.battery_voltage, 2);
      setStat("currVal", latest.current, 2);
      setStat("tempVal", latest.temperature, 1);
      setStat("vibVal", latest.vibration_rms, 3);

      document.getElementById("socBar").style.width = `${Math.max(0, Math.min(100, latest.soc || 0))}%`;
      document.getElementById("sohBar").style.width = `${Math.max(0, Math.min(100, latest.soh || 0))}%`;
    }
    updateCharts(rows);

    const latestWithAlert = await fetchJSON(`/api/uavs/${encodeURIComponent(uavId)}/latest`);
    renderAlert(latestWithAlert.alert, uav ? uav.pending_command : "NONE");
  } catch (e) {
    console.error("Failed to load telemetry:", e);
  }
}

async function sendCommand(uavId, command) {
  try {
    await fetchJSON(`/api/uavs/${encodeURIComponent(uavId)}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
    });
    await refreshFleet();
  } catch (e) {
    alert("Failed to set command: " + e.message);
  }
}

document.getElementById("rtlBtn").addEventListener("click", () => {
  if (selectedUavId) sendCommand(selectedUavId, "RTL");
});
document.getElementById("holdBtn").addEventListener("click", () => {
  if (selectedUavId) sendCommand(selectedUavId, "HOLD");
});
document.getElementById("clearCmdBtn").addEventListener("click", () => {
  if (selectedUavId) sendCommand(selectedUavId, "NONE");
});

async function refreshFleet() {
  try {
    const uavs = await fetchJSON("/api/uavs");
    lastFleetPayload = uavs;
    renderFleetList(uavs);
    const hasActiveUav = Array.isArray(uavs) && uavs.some(u => u.is_active);
    setLinkStatus(hasActiveUav);

    if (selectedUavId) {
      await loadDetail(selectedUavId);
    }
  } catch (e) {
    console.error("Failed to reach backend:", e);
    setLinkStatus(false);
  }
}

function setLinkStatus(online) {
  const dot = document.getElementById("pulseDot");
  const label = document.getElementById("linkLabel");
  const last = document.getElementById("lastUpdate");
  if (online) {
    dot.classList.remove("offline");
    label.classList.remove("offline");
    label.textContent = "ARMED";
    if (last) last.textContent = new Date().toLocaleTimeString();
  } else {
    dot.classList.add("offline");
    label.classList.add("offline");
    label.textContent = "DISARMED";
  }
}

// ---------- Remove UAV ----------

document.getElementById("removeBtn").addEventListener("click", async () => {
  if (!selectedUavId) return;
  if (!confirm(`Remove ${selectedUavId} and all its telemetry history?`)) return;
  try {
    await fetchJSON(`/api/uavs/${encodeURIComponent(selectedUavId)}`, { method: "DELETE" });
    selectedUavId = null;
    document.getElementById("detailContent").style.display = "none";
    document.getElementById("noSelection").style.display = "flex";
    refreshFleet();
  } catch (e) {
    alert("Failed to remove UAV: " + e.message);
  }
});

// ---------- Init ----------

initCharts();
refreshFleet();
setInterval(refreshFleet, POLL_MS);

// ============================================================
// View switching (landing / fleet management / live map)
// Nothing above this point is touched -- the fleet dashboard
// keeps working exactly as it did before.
// ============================================================

function showView(view) {
  document.getElementById("landingView").style.display = view === "landing" ? "flex" : "none";
  document.getElementById("fleetView").style.display = view === "fleet" ? "block" : "none";
  document.getElementById("mapView").style.display = view === "map" ? "block" : "none";

  if (view === "map") {
    initMapIfNeeded();
    refreshMap();
  }
}

document.getElementById("openFleetCard").addEventListener("click", () => showView("fleet"));
document.getElementById("openMapCard").addEventListener("click", () => showView("map"));
document.getElementById("backFromFleetBtn").addEventListener("click", () => showView("landing"));
document.getElementById("backFromMapBtn").addEventListener("click", () => showView("landing"));

// ---------- Live map ----------

let droneMap = null;
let droneMarkers = {}; // uav_id -> Leaflet marker
const DEFAULT_MAP_CENTER = [9.9312, 76.2673]; // fallback view (Kochi area) until real GPS data arrives

function initMapIfNeeded() {
  if (droneMap) return; // already initialized

  droneMap = L.map("droneMap", { zoomControl: true }).setView(DEFAULT_MAP_CENTER, 13);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(droneMap);

  // Leaflet needs a resize nudge the first time its container becomes visible
  setTimeout(() => droneMap.invalidateSize(), 200);
}

function droneIcon() {
  return L.divIcon({
    className: "",
    html: '<div style="font-size:22px; color:#39ff88; transform: translate(-50%,-50%);">▲</div>',
    iconSize: [0, 0],
  });
}

async function refreshMap() {
  try {
    const uavs = await fetchJSON("/api/uavs");

    document.getElementById("mapPulseDot").classList.remove("offline");
    document.getElementById("mapLinkLabel").textContent = "LIVE";

    const listEl = document.getElementById("mapUavList");
    const withGps = uavs.filter(u => u.latest && u.latest.latitude != null && u.latest.longitude != null);

    if (withGps.length === 0) {
      listEl.innerHTML = `<div class="map-empty">No GPS data yet. Once a UAV sends latitude/longitude, it'll appear here and on the map.</div>`;
    } else {
      listEl.innerHTML = withGps.map(u => `
        <div class="map-uav-entry" data-id="${u.uav_id}">
          <div class="map-uav-entry-name">${u.name || u.uav_id}</div>
          <div class="map-uav-entry-coords">
            LAT: <span class="val">${u.latest.latitude.toFixed(6)}</span><br/>
            LON: <span class="val">${u.latest.longitude.toFixed(6)}</span><br/>
            ALT: <span class="val">${u.latest.altitude != null ? u.latest.altitude.toFixed(1) + " m" : "—"}</span>
          </div>
        </div>
      `).join("");

      listEl.querySelectorAll(".map-uav-entry").forEach(el => {
        el.addEventListener("click", () => {
          const u = withGps.find(x => x.uav_id === el.dataset.id);
          if (u) droneMap.setView([u.latest.latitude, u.latest.longitude], 16);
        });
      });
    }

    // Add/update a marker for every UAV that has a GPS fix
    const seenIds = new Set();
    withGps.forEach(u => {
      seenIds.add(u.uav_id);
      const latlng = [u.latest.latitude, u.latest.longitude];
      const popupText = `${u.name || u.uav_id}<br/>Alt: ${u.latest.altitude != null ? u.latest.altitude.toFixed(1) + " m" : "—"}`;

      if (droneMarkers[u.uav_id]) {
        droneMarkers[u.uav_id].setLatLng(latlng).setPopupContent(popupText);
      } else {
        droneMarkers[u.uav_id] = L.marker(latlng, { icon: droneIcon() })
          .addTo(droneMap)
          .bindPopup(popupText);
      }
    });

    // Remove markers for UAVs that no longer have GPS data (e.g. deleted)
    Object.keys(droneMarkers).forEach(id => {
      if (!seenIds.has(id)) {
        droneMap.removeLayer(droneMarkers[id]);
        delete droneMarkers[id];
      }
    });
  } catch (e) {
    console.error("Failed to refresh map:", e);
    document.getElementById("mapPulseDot").classList.add("offline");
    document.getElementById("mapLinkLabel").textContent = "OFFLINE";
  }
}

setInterval(() => {
  if (document.getElementById("mapView").style.display !== "none") {
    refreshMap();
  }
}, POLL_MS);

// Start on the landing page
showView("landing");
