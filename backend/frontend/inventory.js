const API_BASE = "";

let selectedUavId = sessionStorage.getItem("inv_selectedUavId") || "ALL";
let currentLookup = null; // { found, title, description, image_url, source_url }
const lookupCache = new Map(); // query (lowercased) -> result, so retyping the same thing doesn't re-hit the API

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


// ---------- Search on demand (button / Enter) ----------

function resetLookupUI() {
  currentLookup = null;
  document.getElementById("lookupPreview").style.display = "none";
  document.getElementById("addBtn").disabled = document.getElementById("componentInput").value.trim() === "";
}

async function runLookup(query) {
  const statusEl = document.getElementById("lookupStatus");
  const searchBtn = document.getElementById("searchBtn");

  const cacheKey = query.toLowerCase();
  if (lookupCache.has(cacheKey)) {
    applyLookupResult(query, lookupCache.get(cacheKey));
    return;
  }

  statusEl.textContent = "Searching the web…";
  statusEl.className = "lookup-status searching";
  searchBtn.disabled = true;

  try {
    const result = await fetchJSON("/api/inventory/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    // Ignore stale responses if the input has changed since this request started
    if (document.getElementById("componentInput").value.trim() !== query) return;

    lookupCache.set(cacheKey, result);
    applyLookupResult(query, result);
  } catch (e) {
    document.getElementById("lookupStatus").textContent = "Lookup failed — you can still add this manually.";
    document.getElementById("lookupStatus").className = "lookup-status notfound";
    currentLookup = null;
    document.getElementById("addBtn").disabled = document.getElementById("componentInput").value.trim() === "";
  } finally {
    searchBtn.disabled = false;
  }
}

function applyLookupResult(query, result) {
  const statusEl = document.getElementById("lookupStatus");
  currentLookup = result;
  document.getElementById("addBtn").disabled = false;

  if (result.found) {
    statusEl.textContent = "";
    statusEl.className = "lookup-status";
    const preview = document.getElementById("lookupPreview");
    preview.style.display = "flex";
    const img = document.getElementById("lookupImg");
    if (result.image_url) {
      img.src = result.image_url;
      img.style.display = "block";
    } else {
      img.style.display = "none";
    }
    document.getElementById("lookupTitle").textContent = result.title || query;
    document.getElementById("lookupDesc").textContent = result.description || "";
    const sourceLink = document.getElementById("lookupSource");
    if (result.source_url) {
      sourceLink.href = result.source_url;
      sourceLink.style.display = "inline";
    } else {
      sourceLink.style.display = "none";
    }
  } else {
    document.getElementById("lookupPreview").style.display = "none";
    statusEl.textContent = result.error
      ? "Couldn't reach the web lookup (it may be rate-limited right now) — you can still add this manually."
      : "No match found — you can still add this with just the typed name.";
    statusEl.className = "lookup-status notfound";
  }
}

function triggerSearch() {
  const value = document.getElementById("componentInput").value.trim();
  if (value.length < 2) return;
  runLookup(value);
}

document.getElementById("searchBtn").addEventListener("click", triggerSearch);

document.getElementById("componentInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    triggerSearch();
  }
});

document.getElementById("componentInput").addEventListener("input", () => {
  // Typing again after a result was shown invalidates that preview, but we
  // don't auto-search anymore -- the operator explicitly searches when ready.
  document.getElementById("lookupStatus").textContent = "";
  document.getElementById("lookupStatus").className = "lookup-status";
  resetLookupUI();
});

// Manual override fields (used when the web lookup is unavailable, or the
// operator just wants to enter their own details) also unlock the Add button.
["manualTitle", "manualImage", "manualDesc", "manualSource"].forEach(id => {
  document.getElementById(id).addEventListener("input", () => {
    const hasName = document.getElementById("componentInput").value.trim() !== "";
    document.getElementById("addBtn").disabled = !hasName;
  });
});

// ---------- Add to inventory ----------

document.getElementById("addBtn").addEventListener("click", async () => {
  const query = document.getElementById("componentInput").value.trim();
  if (!query) return;

  const qty = parseInt(document.getElementById("qtyInput").value, 10) || 1;
  const addBtn = document.getElementById("addBtn");
  addBtn.disabled = true;
  addBtn.textContent = "Adding…";

  const manualTitle = document.getElementById("manualTitle").value.trim();
  const manualImage = document.getElementById("manualImage").value.trim();
  const manualDesc = document.getElementById("manualDesc").value.trim();
  const manualSource = document.getElementById("manualSource").value.trim();
  const hasManualDetails = manualTitle || manualImage || manualDesc || manualSource;

  const payload = { query, quantity: qty };
  if (selectedUavId && selectedUavId !== "ALL") {
    payload.uav_id = selectedUavId;
  }

  if (hasManualDetails) {
    // Manual entries take priority over anything the web lookup found.
    if (manualTitle) payload.title = manualTitle;
    if (manualImage) payload.image_url = manualImage;
    if (manualDesc) payload.description = manualDesc;
    if (manualSource) payload.source_url = manualSource;
  } else if (currentLookup && currentLookup.found) {
    payload.title = currentLookup.title;
    payload.description = currentLookup.description;
    payload.image_url = currentLookup.image_url;
    payload.source_url = currentLookup.source_url;
  }

  try {
    await fetchJSON("/api/inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    document.getElementById("componentInput").value = "";
    document.getElementById("qtyInput").value = "1";
    ["manualTitle", "manualImage", "manualDesc", "manualSource"].forEach(id => {
      document.getElementById(id).value = "";
    });
    document.getElementById("manualDetails").open = false;
    resetLookupUI();
    document.getElementById("lookupStatus").textContent = "";
    await refreshInventory();
  } catch (e) {
    alert("Failed to add item: " + e.message);
  } finally {
    addBtn.textContent = "Add to Inventory";
    addBtn.disabled = document.getElementById("componentInput").value.trim() === "";
  }
});

// ---------- Inventory list ----------

function renderInventory(items) {
  const list = document.getElementById("invList");
  const empty = document.getElementById("invEmpty");
  document.getElementById("invCount").textContent = items.length;

  if (items.length === 0) {
    list.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  list.innerHTML = items.map(item => `
    <div class="inv-item" data-id="${item.id}">
      ${item.image_url
        ? `<img class="inv-item-img" src="${item.image_url}" alt="" onerror="this.style.display='none'" />`
        : `<div class="inv-item-img"></div>`}
      <div class="inv-item-body">
        <div class="inv-item-title">${item.title || item.query}</div>
        <div class="inv-item-meta">
          <span>${item.query}</span>
          ${item.source_url ? `<a href="${item.source_url}" target="_blank" rel="noopener">source →</a>` : ""}
        </div>
      </div>
      <div class="inv-item-actions">
        <button class="qty-btn" data-action="dec">−</button>
        <span class="qty-val">${item.quantity}</span>
        <button class="qty-btn" data-action="inc">+</button>
        <button class="btn-remove" data-action="remove">Remove</button>
      </div>
    </div>
  `).join("");

  list.querySelectorAll(".inv-item").forEach(el => {
    const id = el.dataset.id;
    const item = items.find(i => String(i.id) === id);
    el.querySelector('[data-action="inc"]').addEventListener("click", () => updateQty(id, item.quantity + 1));
    el.querySelector('[data-action="dec"]').addEventListener("click", () => {
      if (item.quantity > 0) updateQty(id, item.quantity - 1);
    });
    el.querySelector('[data-action="remove"]').addEventListener("click", () => removeItem(id));
  });
}

async function updateQty(id, quantity) {
  try {
    await fetchJSON(`/api/inventory/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity }),
    });
    await refreshInventory();
  } catch (e) {
    alert("Failed to update quantity: " + e.message);
  }
}

async function removeItem(id) {
  if (!confirm("Remove this item from inventory?")) return;
  try {
    await fetchJSON(`/api/inventory/${id}`, { method: "DELETE" });
    await refreshInventory();
  } catch (e) {
    alert("Failed to remove item: " + e.message);
  }
}

async function refreshInventory() {
  try {
    let url = "/api/inventory";
    if (selectedUavId && selectedUavId !== "ALL") {
      url += "?uav_id=" + encodeURIComponent(selectedUavId);
    }
    const [items, uavs] = await Promise.all([
      fetchJSON(url),
      fetchJSON("/api/uavs").catch(() => []),
    ]);

    const select = document.getElementById("uavSelect");
    if (select) {
      select.innerHTML = `<option value="ALL">All Unassigned / Global</option>`;
      if (Array.isArray(uavs)) {
        uavs.forEach(u => {
          const opt = document.createElement("option");
          opt.value = u.uav_id;
          opt.textContent = u.name || u.uav_id;
          select.appendChild(opt);
        });
      }
      select.value = selectedUavId;
    }

    const hasActiveUav = Array.isArray(uavs) && uavs.some(u => u.is_active);
    setLinkStatus(hasActiveUav);
    renderInventory(items);
  } catch (e) {
    console.error("Failed to reach backend:", e);
    setLinkStatus(false);
  }
}

document.getElementById("uavSelect").addEventListener("change", (e) => {
  selectedUavId = e.target.value;
  sessionStorage.setItem("inv_selectedUavId", selectedUavId);
  refreshInventory();
});

resetLookupUI();
refreshInventory();