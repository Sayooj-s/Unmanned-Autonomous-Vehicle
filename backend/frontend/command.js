const API_BASE = "";
const POLL_MS = 3000;

let map;
let uavMarker = null;
let destMarker = null;
let uavsCache = [];
let selectedUavId = "";

function droneIcon() {
  return L.divIcon({
    className: "",
    html: '<div class="drone-marker"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
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

function initMap() {
  map = L.map("cmdMap", { zoomControl: true }).setView([20.5937, 78.9629], 4);

  const darkLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; OpenStreetMap contributors',
    subdomains: "abcd",
    maxZoom: 19,
  }).addTo(map);

  const satelliteLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      attribution: "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      maxZoom: 19,
    }
  );

  L.control.layers(
    { "Dark": darkLayer, "Satellite": satelliteLayer },
    {},
    { position: "topright", collapsed: false }
  ).addTo(map);

  map.on("click", (e) => {
    setDestination(e.latlng.lat, e.latlng.lng);
  });
}

function setDestination(lat, lon) {
  document.getElementById("latInput").value = lat.toFixed(6);
  document.getElementById("lonInput").value = lon.toFixed(6);
  document.getElementById("commandSelect").value = "GOTO";
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
    label.textContent = "LIVE";
  } else {
    dot.classList.add("offline");
    label.classList.add("offline");
    label.textContent = "OFFLINE";
  }
}

function populateUavSelect(uavs) {
  const select = document.getElementById("uavSelect");
  const prevValue = select.value;
  select.innerHTML = '<option value="">Select a UAV…</option>' + uavs.map(u =>
    `<option value="${u.uav_id}">${u.name || u.uav_id} (${u.uav_id})</option>`
  ).join("");
  if (prevValue && uavs.some(u => u.uav_id === prevValue)) {
    select.value = prevValue;
  } else if (!selectedUavId && uavs.length > 0) {
    selectedUavId = uavs[0].uav_id;
    select.value = selectedUavId;
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
}

async function refresh() {
  try {
    const uavs = await fetchJSON("/api/uavs");
    uavsCache = uavs;
    setLinkStatus(true);
    populateUavSelect(uavs);

    if (selectedUavId) {
      const uav = uavs.find(u => u.uav_id === selectedUavId);
      if (uav) renderUavState(uav);
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
}

document.getElementById("commandSelect").addEventListener("change", updateFormMode);

document.getElementById("uavSelect").addEventListener("change", (e) => {
  selectedUavId = e.target.value;
  if (uavMarker) { map.removeLayer(uavMarker); uavMarker = null; }
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

  sendBtn.disabled = true;
  sendBtn.textContent = "Sending…";
  try {
    await fetchJSON(`/api/uavs/${encodeURIComponent(selectedUavId)}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await refresh();
  } catch (err) {
    alert("Failed to send command: " + err.message);
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = "Send Command";
  }
});

initMap();
updateFormMode();
refresh();
setInterval(refresh, POLL_MS);
