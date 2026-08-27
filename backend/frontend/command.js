const API_BASE = "";
const POLL_MS = 3000;

let map;
let uavMarker = null;
let destMarker = null;
let homeMarker = null;
let uavsCache = [];
let selectedUavId = sessionStorage.getItem("cmd_selectedUavId") || "";
let commandSending = false; // true while a command POST is in-flight
let mapClickLocked = false;  // true while a UAV has an active pending command

function droneIcon() {
  return L.divIcon({
    className: "drone-marker-container",
    html: `
      <div class="drone-marker">
        <svg class="drone-svg" viewBox="0 0 36 36" width="36" height="36" xmlns="http://www.w3.org/2000/svg">
          <line x1="8" y1="8" x2="28" y2="28" class="drone-arm" />
          <line x1="28" y1="8" x2="8" y2="28" class="drone-arm" />
          <circle cx="8" cy="8" r="5" class="drone-rotor" />
          <circle cx="28" cy="8" r="5" class="drone-rotor" />
          <circle cx="8" cy="28" r="5" class="drone-rotor" />
          <circle cx="28" cy="28" r="5" class="drone-rotor" />
          <circle cx="8" cy="8" r="1.8" class="drone-hub" />
          <circle cx="28" cy="8" r="1.8" class="drone-hub" />
          <circle cx="8" cy="28" r="1.8" class="drone-hub" />
          <circle cx="28" cy="28" r="1.8" class="drone-hub" />
          <line x1="4.5" y1="8" x2="11.5" y2="8" class="drone-blade" />
          <line x1="24.5" y1="8" x2="31.5" y2="8" class="drone-blade" />
          <line x1="4.5" y1="28" x2="11.5" y2="28" class="drone-blade" />
          <line x1="24.5" y1="28" x2="31.5" y2="28" class="drone-blade" />
          <circle cx="18" cy="18" r="6" class="drone-body" />
          <polygon points="18,13 14.5,19 21.5,19" class="drone-heading" />
        </svg>
      </div>
    `,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -18],
  });
}

function destIcon() {
  return L.divIcon({
    className: "",
    html: '<div class="dest-marker"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function baseIcon() {
  return L.divIcon({
    className: "base-marker-container",
    html: `
      <div class="base-marker" style="background: rgba(167, 139, 250, 0.2); border-radius: 50%; padding: 4px; display: inline-block;">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="#a78bfa" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 3l10 9h-3v9h-14v-9h-3l10-9z"/>
        </svg>
      </div>
    `,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
}

function initMap() {
  map = L.map("cmdMap", { zoomControl: true }).setView([20.5937, 78.9629], 4);

  // Esri Dark Gray Canvas — professional dark basemap, free, no API key
  const darkLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    {
      attribution: "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ",
      maxZoom: 16,
      maxNativeZoom: 16,
    }
  );

  // Esri Dark Gray Reference labels layered on top
  const darkLabels = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 16, maxNativeZoom: 16, pane: "shadowPane" }
  );
  const darkGroup = L.layerGroup([darkLayer, darkLabels]);
  darkGroup.addTo(map);

  const satelliteLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics",
      maxZoom: 19,
      maxNativeZoom: 17,
    }
  );

  L.control.layers(
    { "Dark": darkGroup, "Satellite": satelliteLayer },
    {},
    { position: "topright", collapsed: false }
  ).addTo(map);

  map.on("click", (e) => {
    if (commandSending || mapClickLocked) return; // block map clicks while sending or command is active
    setDestination(e.latlng.lat, e.latlng.lng);
  });
}

function setDestination(lat, lon) {
  document.getElementById("latInput").value = lat.toFixed(6);
  document.getElementById("lonInput").value = lon.toFixed(6);
  document.getElementById("commandSelect").value = "GOTO";
  sessionStorage.setItem("cmd_lat", lat.toFixed(6));
  sessionStorage.setItem("cmd_lon", lon.toFixed(6));
  updateFormMode();

  if (destMarker) {
    destMarker.setLatLng([lat, lon]);
  } else {
    destMarker = L.marker([lat, lon], { icon: destIcon(), draggable: true })
      .addTo(map)
      .bindPopup("Destination");
    destMarker.on("dragend", () => {
      const ll = destMarker.getLatLng();
      document.getElementById("latInput").value = ll.lat.toFixed(6);
      document.getElementById("lonInput").value = ll.lng.toFixed(6);
    });
  }
}

function clearDestination() {
  if (destMarker) {
    map.removeLayer(destMarker);
    destMarker = null;
  }
  document.getElementById("latInput").value = "";
  document.getElementById("lonInput").value = "";
  sessionStorage.removeItem("cmd_lat");
  sessionStorage.removeItem("cmd_lon");
}

async function fetchJSON(path, opts) {
  const res = await fetch(API_BASE + path, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

function setLinkStatus(online) {
  const dot = document.getElementById("pulseDot");
  const label = document.getElementById("linkLabel");
  if (online) {
    dot.classList.remove("offline");
    label.classList.remove("offline");
    label.textContent = "ARMED";
  } else {
    dot.classList.add("offline");
    label.classList.add("offline");
    label.textContent = "DISARMED";
  }
}

function populateUavSelect(uavs) {
  const select = document.getElementById("uavSelect");
  select.innerHTML = '<option value="">Select a UAV…</option>' + uavs.map(u =>
    `<option value="${u.uav_id}">${u.name || u.uav_id} (${u.uav_id})</option>`
  ).join("");

  if (selectedUavId && uavs.some(u => u.uav_id === selectedUavId)) {
    // Restore previously selected UAV (survives Home/Back navigation)
    select.value = selectedUavId;
    const uav = uavs.find(u => u.uav_id === selectedUavId);
    if (uav) renderUavState(uav);
  } else if (selectedUavId && !uavs.some(u => u.uav_id === selectedUavId)) {
    // UAV was deleted — clear stale session state
    selectedUavId = "";
    sessionStorage.removeItem("cmd_selectedUavId");
    document.getElementById("cmdEmpty").style.display = "block";
    document.getElementById("cmdContent").style.display = "none";
  } else if (!selectedUavId && uavs.length > 0) {
    // Nothing selected yet — pick the first UAV automatically
    selectedUavId = uavs[0].uav_id;
    select.value = selectedUavId;
    sessionStorage.setItem("cmd_selectedUavId", selectedUavId);
    const uav = uavs.find(u => u.uav_id === selectedUavId);
    if (uav) renderUavState(uav);
  }
}

function renderUavState(uav) {
  document.getElementById("cmdEmpty").style.display = "none";
  document.getElementById("cmdContent").style.display = "block";

  const latest = uav.latest;
  const soc = latest ? latest.soc : null;
  document.getElementById("battVal").textContent = (soc === null || soc === undefined) ? "—" : soc.toFixed(0);
  document.getElementById("battBar").style.width = `${Math.max(0, Math.min(100, soc || 0))}%`;
  document.getElementById("battBar").style.background =
    soc !== null && soc !== undefined && soc < 20 ? "var(--red)" :
    soc !== null && soc !== undefined && soc < 35 ? "var(--amber)" : "var(--accent)";
  document.getElementById("battUpdated").textContent =
    latest && latest.timestamp ? `updated ${new Date(latest.timestamp).toLocaleTimeString()}` : "no telemetry yet";

  document.getElementById("currentCmd").textContent = uav.pending_command || "NONE";

  const destRow = document.getElementById("currentDestRow");
  if (uav.pending_command === "GOTO" && uav.command_lat != null && uav.command_lon != null) {
    destRow.style.display = "flex";
    document.getElementById("currentDest").textContent =
      `${uav.command_lat.toFixed(6)}, ${uav.command_lon.toFixed(6)}`;
  } else {
    destRow.style.display = "none";
  }

  // Lock map clicks when a command is active; unlock when cleared
  const hasActiveCmd = uav.pending_command && uav.pending_command !== "NONE";
  mapClickLocked = hasActiveCmd;
  const mapLayerHint = document.getElementById("mapLayerHint");
  const mapHint = document.getElementById("mapHint");
  if (hasActiveCmd) {
    if (mapLayerHint) {
      mapLayerHint.textContent = `Command active (${uav.pending_command}) — clear it before setting a new destination.`;
      mapLayerHint.style.display = "block";
    }
    if (mapHint) mapHint.textContent = `Active command: ${uav.pending_command}. Send CLEAR first to set a new destination.`;
  } else {
    if (mapLayerHint) mapLayerHint.style.display = "none";
    if (mapHint) mapHint.textContent = "Click the map to set the destination, or type coordinates directly.";
  }

  // Place/update the UAV marker on the map if it has a GPS fix
  if (latest && latest.latitude != null && latest.longitude != null) {
    const latlng = [latest.latitude, latest.longitude];
    if (uavMarker) {
      uavMarker.setLatLng(latlng);
    } else {
      uavMarker = L.marker(latlng, { icon: droneIcon() }).addTo(map).bindPopup(uav.name || uav.uav_id);
      map.setView(latlng, 14);
    }
  }

  // Update the dynamic Home Base marker to where this UAV first started
  if (uav.home_lat != null && uav.home_lon != null) {
    const homeLatLng = [uav.home_lat, uav.home_lon];
    if (homeMarker) {
      homeMarker.setLatLng(homeLatLng);
      homeMarker.getPopup().setContent(`Home Base (${uav.name || uav.uav_id})`);
    } else {
      homeMarker = L.marker(homeLatLng, { icon: baseIcon() })
        .addTo(map)
        .bindPopup(`Home Base (${uav.name || uav.uav_id})`);
    }
  } else if (homeMarker) {
    map.removeLayer(homeMarker);
    homeMarker = null;
  }
}

async function refresh() {
  try {
    const uavs = await fetchJSON("/api/uavs");
    uavsCache = uavs;
    populateUavSelect(uavs);

    if (selectedUavId) {
      const uav = uavs.find(u => u.uav_id === selectedUavId);
      if (uav) {
        renderUavState(uav);
        setLinkStatus(Boolean(uav.is_active));
      } else {
        setLinkStatus(false);
      }
    } else {
      const hasActiveUav = Array.isArray(uavs) && uavs.some(u => u.is_active);
      setLinkStatus(hasActiveUav);
    }
  } catch (e) {
    console.error("Failed to reach backend:", e);
    setLinkStatus(false);
  }
}

function updateFormMode() {
  const cmd = document.getElementById("commandSelect").value;
  document.getElementById("latlonFields").style.display = cmd === "GOTO" ? "grid" : "none";
  document.getElementById("mapHint").style.display = cmd === "GOTO" ? "block" : "none";
  // Persist the chosen command type across navigation
  sessionStorage.setItem("cmd_command", cmd);
}

function setCommandLock(locked) {
  commandSending = locked;
  document.getElementById("uavSelect").disabled = locked;
  document.getElementById("commandSelect").disabled = locked;
  document.getElementById("latInput").disabled = locked;
  document.getElementById("lonInput").disabled = locked;
  document.getElementById("sendBtn").disabled = locked;
  // Visual cue on the map area
  const mapWrap = document.querySelector(".cmd-map-wrap");
  if (mapWrap) mapWrap.style.pointerEvents = locked ? "none" : "";
}

document.getElementById("commandSelect").addEventListener("change", updateFormMode);

document.getElementById("uavSelect").addEventListener("change", (e) => {
  if (commandSending) return; // block UAV switch while sending
  selectedUavId = e.target.value;
  sessionStorage.setItem("cmd_selectedUavId", selectedUavId);
  if (uavMarker) { map.removeLayer(uavMarker); uavMarker = null; }
  if (homeMarker) { map.removeLayer(homeMarker); homeMarker = null; }
  if (!selectedUavId) {
    document.getElementById("cmdEmpty").style.display = "block";
    document.getElementById("cmdContent").style.display = "none";
    return;
  }
  const uav = uavsCache.find(u => u.uav_id === selectedUavId);
  if (uav) renderUavState(uav);
});

document.getElementById("cmdForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selectedUavId) return;

  const command = document.getElementById("commandSelect").value;
  const sendBtn = document.getElementById("sendBtn");
  const payload = { command };

  if (command === "GOTO") {
    const lat = parseFloat(document.getElementById("latInput").value);
    const lon = parseFloat(document.getElementById("lonInput").value);
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      alert("Enter a destination latitude and longitude, or click the map to set one.");
      return;
    }
    payload.lat = lat;
    payload.lon = lon;
  }

  setCommandLock(true);
  sendBtn.textContent = "Sending…";
  try {
    await fetchJSON(`/api/uavs/${encodeURIComponent(selectedUavId)}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (command === "NONE") {
      clearDestination();
    }
    await refresh();
  } catch (err) {
    alert("Failed to send command: " + err.message);
  } finally {
    setCommandLock(false);
    sendBtn.textContent = "Send Command";
  }
});

initMap();

// Restore persisted command type and coordinates after Home/Back navigation
(function restoreFormState() {
  const savedCmd = sessionStorage.getItem("cmd_command");
  if (savedCmd) {
    const sel = document.getElementById("commandSelect");
    if ([...sel.options].some(o => o.value === savedCmd)) sel.value = savedCmd;
  }
  const savedLat = parseFloat(sessionStorage.getItem("cmd_lat"));
  const savedLon = parseFloat(sessionStorage.getItem("cmd_lon"));
  // Re-place the destination marker on the map so it survives navigation
  if (!Number.isNaN(savedLat) && !Number.isNaN(savedLon)) {
    setDestination(savedLat, savedLon);
  }
})();

updateFormMode();
refresh();
setInterval(refresh, POLL_MS);
