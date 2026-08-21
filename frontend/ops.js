const API_BASE = "";
const POLL_MS = 3000;

let fleet = [];
let lookupTimer = null;

async function fetchJSON(path, opts) {
  const res = await fetch(API_BASE + path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || JSON.stringify(body);
    } catch (_) { /* ignore */ }
    throw new Error(detail);
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

function batteryClass(soc) {
  if (soc == null) return "";
  if (soc < 20) return "crit";
  if (soc < 40) return "warn";
  return "";
}

function formatPending(uav) {
  if (!uav || !uav.pending_command || uav.pending_command === "NONE") {
    return "No pending command.";
  }
  let text = `Pending: ${uav.pending_command}`;
  if (uav.command_lat != null && uav.command_lon != null) {
    text += `  →  ${uav.command_lat.toFixed(6)}, ${uav.command_lon.toFixed(6)}`;
  }
  return text;
}

function updateBatteryAndPending() {
  const id = document.getElementById("uavSelect").value;
  const uav = fleet.find(u => u.uav_id === id);
  const readout = document.getElementById("batteryReadout");
  const soc = uav && uav.latest ? uav.latest.soc : null;
  readout.className = "battery-readout " + batteryClass(soc);
  readout.textContent = soc == null ? "—" : `${Number(soc).toFixed(0)}%`;
  document.getElementById("pendingRow").textContent = formatPending(uav);
}

async function refreshFleet() {
  try {
    const uavs = await fetchJSON("/api/uavs");
    fleet = uavs;
    setLinkStatus(true);

    const select = document.getElementById("uavSelect");
    const current = select.value;
    select.innerHTML = `<option value="">Select a UAV…</option>` + uavs.map(u =>
      `<option value="${u.uav_id}">${u.name || u.uav_id}</option>`
    ).join("");
    if (current && uavs.some(u => u.uav_id === current)) {
      select.value = current;
    }
    updateBatteryAndPending();
  } catch (e) {
    console.error(e);
    setLinkStatus(false);
  }
}

document.getElementById("uavSelect").addEventListener("change", updateBatteryAndPending);

document.getElementById("sendCmdBtn").addEventListener("click", async () => {
  const uavId = document.getElementById("uavSelect").value;
  if (!uavId) {
    alert("Select a UAV first.");
    return;
  }
  const command = document.getElementById("commandSelect").value;
  const latRaw = document.getElementById("latInput").value;
  const lonRaw = document.getElementById("lonInput").value;
  const body = { command };
  if (latRaw !== "") body.latitude = Number(latRaw);
  if (lonRaw !== "") body.longitude = Number(lonRaw);

  if (command === "GOTO" && (latRaw === "" || lonRaw === "")) {
    alert("GOTO needs both destination latitude and longitude.");
    return;
  }

  try {
    await fetchJSON(`/api/uavs/${encodeURIComponent(uavId)}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await refreshFleet();
  } catch (e) {
    alert("Failed to send command: " + e.message);
  }
});

function thumbHtml(url) {
  if (url) return `<img src="${url}" alt="" />`;
  return `<div class="thumb-fallback">▢</div>`;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderLookup(results, query) {
  const el = document.getElementById("lookupResults");
  const status = document.getElementById("lookupStatus");
  if (!results.length) {
    status.textContent = `No web matches for “${query}”. You can still add it with just the model name.`;
    el.innerHTML = `
      <div class="result-card">
        ${thumbHtml(null)}
        <div>
          <div class="result-title">${escapeHtml(query)}</div>
          <div class="result-desc">No Wikipedia details found. Insert the model as a custom inventory row.</div>
        </div>
        <button class="btn-add" data-custom="1">Insert</button>
      </div>`;
    el.querySelector(".btn-add").addEventListener("click", () => insertItem({
      model: query,
      title: query,
    }));
    return;
  }
  status.textContent = `${results.length} match${results.length === 1 ? "" : "es"} from the web`;
  el.innerHTML = results.map((r, i) => `
    <div class="result-card">
      ${thumbHtml(r.image_url)}
      <div>
        <div class="result-title">${escapeHtml(r.title)}</div>
        <div class="result-desc">${escapeHtml(r.description || "No summary available.")}</div>
        ${r.source_url ? `<a class="result-source" href="${escapeHtml(r.source_url)}" target="_blank" rel="noopener">Open source ↗</a>` : ""}
      </div>
      <button class="btn-add" data-idx="${i}">Insert</button>
    </div>
  `).join("");

  el.querySelectorAll(".btn-add").forEach(btn => {
    btn.addEventListener("click", () => {
      const r = results[Number(btn.dataset.idx)];
      insertItem({
        model: query,
        title: r.title,
        description: r.description,
        image_url: r.image_url,
        source_url: r.source_url,
      });
    });
  });
}

async function lookupModel(query) {
  const status = document.getElementById("lookupStatus");
  status.textContent = "Looking up from the web…";
  try {
    const data = await fetchJSON(`/api/inventory/lookup?q=${encodeURIComponent(query)}`);
    renderLookup(data.results || [], query);
  } catch (e) {
    status.textContent = "Lookup failed: " + e.message;
  }
}

document.getElementById("modelInput").addEventListener("input", (e) => {
  const q = e.target.value.trim();
  clearTimeout(lookupTimer);
  if (q.length < 2) {
    document.getElementById("lookupStatus").textContent = "";
    document.getElementById("lookupResults").innerHTML = "";
    return;
  }
  document.getElementById("lookupStatus").textContent = "Typing…";
  lookupTimer = setTimeout(() => lookupModel(q), 450);
});

async function insertItem(payload) {
  try {
    await fetchJSON("/api/inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await refreshInventory();
  } catch (e) {
    alert("Failed to insert: " + e.message);
  }
}

async function refreshInventory() {
  try {
    const items = await fetchJSON("/api/inventory");
    const list = document.getElementById("inventoryList");
    if (!items.length) {
      list.innerHTML = `<div class="inv-empty">No components stored yet. Type a model above and insert a match.</div>`;
      return;
    }
    list.innerHTML = items.map(item => `
      <div class="inv-card">
        ${thumbHtml(item.image_url)}
        <div>
          <div class="inv-title">${escapeHtml(item.title || item.model)}</div>
          <div class="inv-desc">${escapeHtml(item.model)}${item.description ? " — " + escapeHtml(item.description) : ""}</div>
        </div>
        <button class="btn-remove" data-id="${item.id}">Remove</button>
      </div>
    `).join("");
    list.querySelectorAll(".btn-remove").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          await fetchJSON(`/api/inventory/${btn.dataset.id}`, { method: "DELETE" });
          await refreshInventory();
        } catch (e) {
          alert("Failed to remove: " + e.message);
        }
      });
    });
  } catch (e) {
    console.error(e);
  }
}

refreshFleet();
refreshInventory();
setInterval(refreshFleet, POLL_MS);
