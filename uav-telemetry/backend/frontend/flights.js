const API_BASE = window.API_BASE || "";

let flightsCache = [];

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

function formatDuration(seconds) {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function formatDistance(meters) {
  if (meters == null) return "—";
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${meters.toFixed(0)} m`;
}

async function populateUavFilter() {
  try {
    const uavs = await fetchJSON("/api/uavs");
    const options = '<option value="">All UAVs</option>' + uavs.map(u =>
      `<option value="${u.uav_id}">${u.name || u.uav_id} (${u.uav_id})</option>`
    ).join("");

    const filterSelect = document.getElementById("uavFilter");
    const prevFilter = filterSelect.value;
    filterSelect.innerHTML = options;
    if (prevFilter) filterSelect.value = prevFilter;

    const rangeSelect = document.getElementById("rangeUav");
    const prevRange = rangeSelect.value;
    rangeSelect.innerHTML = '<option value="">Select a UAV…</option>' + uavs.map(u =>
      `<option value="${u.uav_id}">${u.name || u.uav_id} (${u.uav_id})</option>`
    ).join("");
    if (prevRange) rangeSelect.value = prevRange;
    updateAllExportBtn();
  } catch (e) {
    // Non-fatal -- the flight list itself still works without these populated.
  }
}

function updateAllExportBtn() {
  const rangeUav = document.getElementById("rangeUav");
  const allBtn = document.getElementById("allExportBtn");
  if (rangeUav && allBtn) {
    if (rangeUav.value) {
      allBtn.href = `/api/uavs/${encodeURIComponent(rangeUav.value)}/telemetry/export.csv`;
      allBtn.style.display = "inline-block";
    } else {
      allBtn.style.display = "none";
    }
  }
}

document.getElementById("rangeUav").addEventListener("change", updateAllExportBtn);

function renderFlights(flights) {
  const list = document.getElementById("flList");
  const empty = document.getElementById("flEmpty");
  document.getElementById("flCount").textContent = flights.length;

  if (flights.length === 0) {
    list.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  list.innerHTML = flights.map(f => {
    const started = new Date(f.started_at);
    const startedLabel = started.toLocaleString();
    const s = f.summary || {};
    return `
      <div class="fl-item" data-id="${f.id}">
        <div class="fl-item-top">
          <div class="fl-item-title">
            <span class="fl-item-uav">${f.uav_id}</span>
            ${f.label ? `<span class="fl-item-label">${f.label}</span>` : ""}
            ${f.in_progress ? `<span class="fl-badge">RECORDING</span>` : ""}
          </div>
          <span class="fl-item-time">${startedLabel}</span>
        </div>
        <div class="fl-stats">
          <div class="fl-stat">
            <div class="fl-stat-label">DURATION</div>
            <div class="fl-stat-val">${formatDuration(s.duration_seconds)}</div>
          </div>
          <div class="fl-stat">
            <div class="fl-stat-label">DISTANCE</div>
            <div class="fl-stat-val">${formatDistance(s.distance_m)}</div>
          </div>
          <div class="fl-stat">
            <div class="fl-stat-label">MAX ALT</div>
            <div class="fl-stat-val">${s.max_altitude != null ? s.max_altitude.toFixed(1) + " m" : "—"}</div>
          </div>
          <div class="fl-stat">
            <div class="fl-stat-label">SOC RANGE</div>
            <div class="fl-stat-val">${s.min_soc != null ? `${s.min_soc.toFixed(0)}–${s.max_soc.toFixed(0)}%` : "—"}</div>
          </div>
          <div class="fl-stat">
            <div class="fl-stat-label">SAMPLES</div>
            <div class="fl-stat-val">${s.sample_count ?? 0}</div>
          </div>
        </div>
        <div class="fl-item-actions">
          <a class="btn-export" href="/api/flights/${f.id}/export.csv" download>Export CSV</a>
          <button class="btn-delete-flight" data-action="delete">Delete</button>
        </div>
      </div>
    `;
  }).join("");

  list.querySelectorAll(".fl-item").forEach(el => {
    const id = el.dataset.id;
    el.querySelector('[data-action="delete"]').addEventListener("click", () => deleteFlight(id));
  });
}

async function deleteFlight(id) {
  if (!confirm("Delete this flight record? (Raw telemetry data is kept either way.)")) return;
  try {
    await fetchJSON(`/api/flights/${id}`, { method: "DELETE" });
    await refreshFlights();
  } catch (e) {
    alert("Failed to delete flight: " + e.message);
  }
}

async function refreshFlights() {
  const uavId = document.getElementById("uavFilter").value;
  const path = uavId ? `/api/flights?uav_id=${encodeURIComponent(uavId)}` : "/api/flights";
  try {
    const [flights, uavs] = await Promise.all([
      fetchJSON(path),
      fetchJSON("/api/uavs").catch(() => []),
    ]);
    flightsCache = flights;
    renderFlights(flights);

    if (uavId) {
      const uav = uavs.find(u => u.uav_id === uavId);
      setLinkStatus(Boolean(uav && uav.is_active));
    } else {
      const hasActiveUav = Array.isArray(uavs) && uavs.some(u => u.is_active);
      setLinkStatus(hasActiveUav);
    }
  } catch (e) {
    console.error("Failed to reach backend:", e);
    setLinkStatus(false);
  }
}

document.getElementById("uavFilter").addEventListener("change", refreshFlights);

// ---------- Custom date/time range query ----------

function renderStatCards(container, s) {
  container.innerHTML = `
    <div class="fl-stat">
      <div class="fl-stat-label">DURATION</div>
      <div class="fl-stat-val">${formatDuration(s.duration_seconds)}</div>
    </div>
    <div class="fl-stat">
      <div class="fl-stat-label">DISTANCE</div>
      <div class="fl-stat-val">${formatDistance(s.distance_m)}</div>
    </div>
    <div class="fl-stat">
      <div class="fl-stat-label">MAX ALT</div>
      <div class="fl-stat-val">${s.max_altitude != null ? s.max_altitude.toFixed(1) + " m" : "—"}</div>
    </div>
    <div class="fl-stat">
      <div class="fl-stat-label">SOC RANGE</div>
      <div class="fl-stat-val">${s.min_soc != null ? `${s.min_soc.toFixed(0)}–${s.max_soc.toFixed(0)}%` : "—"}</div>
    </div>
    <div class="fl-stat">
      <div class="fl-stat-label">SAMPLES</div>
      <div class="fl-stat-val">${s.sample_count ?? 0}</div>
    </div>
  `;
}

document.getElementById("rangeQueryBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("rangeStatus");
  const resultEl = document.getElementById("rangeResult");
  const exportBtn = document.getElementById("rangeExportBtn");
  const btn = document.getElementById("rangeQueryBtn");

  const uavId = document.getElementById("rangeUav").value;
  const startVal = document.getElementById("rangeStart").value;
  const endVal = document.getElementById("rangeEnd").value;

  statusEl.className = "range-status";
  resultEl.style.display = "none";
  exportBtn.style.display = "none";

  if (!uavId || !startVal || !endVal) {
    statusEl.textContent = "Pick a UAV, start, and end time.";
    statusEl.className = "range-status error";
    return;
  }

  // datetime-local inputs are in the browser's local timezone; convert to a
  // UTC instant here so it lines up with how telemetry timestamps are
  // stored on the backend (UTC).
  const startDate = new Date(startVal);
  const endDate = new Date(endVal);
  if (endDate <= startDate) {
    statusEl.textContent = "End must be after start.";
    statusEl.className = "range-status error";
    return;
  }

  const startISO = startDate.toISOString();
  const endISO = endDate.toISOString();

  btn.disabled = true;
  btn.textContent = "Loading…";
  statusEl.textContent = "";

  try {
    const params = `start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`;
    const result = await fetchJSON(`/api/uavs/${encodeURIComponent(uavId)}/telemetry/range?${params}`);

    renderStatCards(document.getElementById("rangeStats"), result.summary);
    resultEl.style.display = "block";

    exportBtn.href = `/api/uavs/${encodeURIComponent(uavId)}/telemetry/range/export.csv?${params}`;
    exportBtn.style.display = "inline-block";

    if (result.summary.sample_count === 0) {
      statusEl.textContent = "No telemetry found in that range.";
    }
  } catch (e) {
    statusEl.textContent = "Failed to load: " + e.message;
    statusEl.className = "range-status error";
  } finally {
    btn.disabled = false;
    btn.textContent = "View Summary";
  }
});

populateUavFilter();
refreshFlights();
setInterval(refreshFlights, 5000);
