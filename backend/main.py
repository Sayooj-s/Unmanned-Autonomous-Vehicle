"""
UAV Telemetry Backend
----------------------
Stores battery health (voltage, SoC, SoH), temperature, and vibration data
from multiple UAVs, keyed by uav_id. Each UAV's companion computer (e.g. a
Raspberry Pi running the flight controller bridge) POSTs readings here.

Run locally:
    pip install -r requirements.txt
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload

Then open http://localhost:8000 for the dashboard.
"""

import os
import time
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import create_engine, Column, Integer, String, Float, DateTime, ForeignKey
from sqlalchemy.orm import sessionmaker, declarative_base, relationship, Session

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "uav_data.db")

# Reads DATABASE_URL from the environment if it's set (e.g. on Render/Railway,
# a Postgres connection string like postgresql://user:pass@host:5432/dbname).
# Falls back to a local SQLite file when DATABASE_URL isn't set, so this still
# runs with zero setup on your laptop.
DATABASE_URL = os.environ.get("DATABASE_URL")

if DATABASE_URL:
    # Render/Railway sometimes hand out "postgres://" — SQLAlchemy needs "postgresql://"
    if DATABASE_URL.startswith("postgres://"):
        DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)
    engine = create_engine(DATABASE_URL)
else:
    engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


# ---------------------------------------------------------------------------
# Database models
# ---------------------------------------------------------------------------

class UAV(Base):
    __tablename__ = "uavs"
    uav_id = Column(String, primary_key=True, index=True)
    name = Column(String, nullable=True)
    model = Column(String, nullable=True)
    registered_at = Column(DateTime, default=datetime.utcnow)

    # The action the backend wants this UAV to take right now: "NONE",
    # "RTL" (return to launch), "HOLD" (loiter in place), or "GOTO" (fly to
    # command_lat/command_lon). The companion computer (e.g. Jetson) polls
    # GET /api/uavs/{uav_id}/command and acts on this, then the backend
    # clears it back to "NONE" once issued.
    pending_command = Column(String, default="NONE")
    command_lat = Column(Float, nullable=True)   # destination latitude for GOTO
    command_lon = Column(Float, nullable=True)   # destination longitude for GOTO

    telemetry = relationship("Telemetry", back_populates="uav", cascade="all, delete-orphan")


class InventoryItem(Base):
    """A spare part / component in the build inventory. `query` is exactly
    what the operator typed (e.g. a model number); the rest is filled in
    by a best-effort web lookup at add-time, and can be overridden."""
    __tablename__ = "inventory"
    id = Column(Integer, primary_key=True, index=True)
    query = Column(String)
    title = Column(String, nullable=True)
    description = Column(String, nullable=True)
    image_url = Column(String, nullable=True)
    source_url = Column(String, nullable=True)
    quantity = Column(Integer, default=1)
    added_at = Column(DateTime, default=datetime.utcnow)


class Telemetry(Base):
    __tablename__ = "telemetry"
    id = Column(Integer, primary_key=True, index=True)
    uav_id = Column(String, ForeignKey("uavs.uav_id"), index=True)
    timestamp = Column(DateTime, default=datetime.utcnow, index=True)

    # Battery Management System (BMS) fields
    battery_voltage = Column(Float, nullable=True)   # pack voltage (V)
    current = Column(Float, nullable=True)           # draw current (A)
    soc = Column(Float, nullable=True)                # State of Charge (%)
    soh = Column(Float, nullable=True)                # State of Health (%)
    temperature = Column(Float, nullable=True)        # battery/pack temp (deg C)

    # Vibration (from IMU / flight controller)
    vibration_x = Column(Float, nullable=True)
    vibration_y = Column(Float, nullable=True)
    vibration_z = Column(Float, nullable=True)
    vibration_rms = Column(Float, nullable=True)      # computed on ingest

    # Optional flight context
    altitude = Column(Float, nullable=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)

    uav = relationship("UAV", back_populates="telemetry")


# ---------------------------------------------------------------------------
# Safety thresholds
# ---------------------------------------------------------------------------
# Tune these for your actual battery chemistry/airframe. These are reasonable
# starting points for a small multirotor on a 6S LiPo -- adjust after you've
# logged a few real flights and know your normal vibration/temperature range.

THRESHOLDS = {
    "soc_critical": 20.0,      # % -- below this, not enough charge to safely return
    "soc_warning": 35.0,       # % -- getting low, worth a heads-up
    "temp_critical": 60.0,     # deg C -- battery pack overheating
    "temp_warning": 50.0,
    "vibration_critical": 0.30,  # RMS -- vibration high enough to risk IMU/prop issues
    "vibration_warning": 0.20,
}


def evaluate_alert(latest: "Telemetry | None") -> dict:
    """Look at the most recent reading and decide if the UAV is safe,
    should be warned about, or needs to return/hold right now."""
    if latest is None:
        return {"level": "unknown", "reasons": []}

    reasons = []
    level = "ok"

    if latest.soc is not None:
        if latest.soc <= THRESHOLDS["soc_critical"]:
            reasons.append(f"Battery critically low ({latest.soc:.0f}% SoC) -- may not have enough charge to return")
            level = "critical"
        elif latest.soc <= THRESHOLDS["soc_warning"] and level != "critical":
            reasons.append(f"Battery getting low ({latest.soc:.0f}% SoC)")
            level = "warning"

    if latest.temperature is not None:
        if latest.temperature >= THRESHOLDS["temp_critical"]:
            reasons.append(f"Battery temperature exceeds safe limit ({latest.temperature:.1f}°C)")
            level = "critical"
        elif latest.temperature >= THRESHOLDS["temp_warning"] and level != "critical":
            reasons.append(f"Battery temperature elevated ({latest.temperature:.1f}°C)")
            level = "warning" if level == "ok" else level

    if latest.vibration_rms is not None:
        if latest.vibration_rms >= THRESHOLDS["vibration_critical"]:
            reasons.append(f"Vibration too high ({latest.vibration_rms:.3f}g RMS)")
            level = "critical"
        elif latest.vibration_rms >= THRESHOLDS["vibration_warning"] and level != "critical":
            reasons.append(f"Vibration elevated ({latest.vibration_rms:.3f}g RMS)")
            level = "warning" if level == "ok" else level

    return {"level": level, "reasons": reasons}


Base.metadata.create_all(bind=engine)


# ---------------------------------------------------------------------------
# Component lookup (best-effort web search, no API key required)
# ---------------------------------------------------------------------------
# Uses the `duckduckgo-search` package to find a title/description/image for
# whatever the operator typed (e.g. "T-Motor MN3110 780KV"). This is a
# best-effort convenience, not an authoritative parts database -- results can
# be missing or wrong, so the operator can always edit/override before
# saving, and the raw query is always kept alongside whatever was found.
#
# In-memory cache (per backend process) so re-searching the same part name
# doesn't burn another request against DuckDuckGo's rate limit. Cleared on
# restart -- fine for this use case, not meant to be durable storage.
_lookup_cache: dict = {}
LOOKUP_CACHE_TTL_SECONDS = 60 * 60 * 6  # 6 hours

def lookup_component(query: str) -> dict:
    query = (query or "").strip()
    if not query:
        return {"found": False}

    cache_key = query.lower()
    cached = _lookup_cache.get(cache_key)
    if cached is not None and (time.time() - cached["_cached_at"]) < LOOKUP_CACHE_TTL_SECONDS:
        return {k: v for k, v in cached.items() if k != "_cached_at"}

    try:
        # `duckduckgo_search` was renamed to `ddgs` -- try the new package
        # first, fall back to the old one so this keeps working either way.
        try:
            from ddgs import DDGS
        except ImportError:
            from duckduckgo_search import DDGS
    except ImportError:
        return {"found": False, "error": "ddgs (or duckduckgo-search) is not installed on the backend"}

    title = None
    description = None
    source_url = None
    image_url = None
    errors = []

    # Text and image search are independent -- DuckDuckGo's image endpoint in
    # particular gets rate-limited/blocked more often than the text one, so a
    # broken image lookup shouldn't also sink a working text result.
    try:
        with DDGS() as ddgs:
            text_results = list(ddgs.text(f"{query} specifications datasheet", max_results=3))
            if text_results:
                top = text_results[0]
                title = top.get("title")
                description = top.get("body")
                source_url = top.get("href")
    except Exception as e:
        errors.append(f"text search: {e}")

    try:
        with DDGS() as ddgs:
            image_results = list(ddgs.images(query, max_results=3))
            if image_results:
                image_url = image_results[0].get("image")
    except Exception as e:
        errors.append(f"image search: {e}")

    if not title and not image_url:
        return {"found": False, "error": "; ".join(errors) if errors else None}

    result = {
        "found": True,
        "title": title or query,
        "description": description,
        "image_url": image_url,
        "source_url": source_url,
    }
    _lookup_cache[cache_key] = {**result, "_cached_at": time.time()}
    return result


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="UAV Telemetry Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Request/response schemas
# ---------------------------------------------------------------------------

class UAVRegister(BaseModel):
    uav_id: str
    name: Optional[str] = None
    model: Optional[str] = None


class CommandIn(BaseModel):
    command: str  # "NONE", "RTL", "HOLD", or "GOTO"
    lat: Optional[float] = None   # required when command == "GOTO"
    lon: Optional[float] = None   # required when command == "GOTO"


class InventoryLookupIn(BaseModel):
    query: str


class InventoryAddIn(BaseModel):
    query: str
    quantity: Optional[int] = 1
    # Optional overrides -- if provided, these are trusted as-is and no
    # lookup is performed. Lets the frontend save exactly what it already
    # showed the operator in the lookup preview, without a second search.
    title: Optional[str] = None
    description: Optional[str] = None
    image_url: Optional[str] = None
    source_url: Optional[str] = None


class InventoryUpdateIn(BaseModel):
    quantity: Optional[int] = None


class TelemetryIn(BaseModel):
    timestamp: Optional[datetime] = None
    battery_voltage: Optional[float] = None
    current: Optional[float] = None
    soc: Optional[float] = None
    soh: Optional[float] = None
    temperature: Optional[float] = None
    vibration_x: Optional[float] = None
    vibration_y: Optional[float] = None
    vibration_z: Optional[float] = None
    altitude: Optional[float] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None


def serialize_telemetry(row: Telemetry) -> dict:
    return {
        "id": row.id,
        "uav_id": row.uav_id,
        "timestamp": row.timestamp.isoformat() if row.timestamp else None,
        "battery_voltage": row.battery_voltage,
        "current": row.current,
        "soc": row.soc,
        "soh": row.soh,
        "temperature": row.temperature,
        "vibration_x": row.vibration_x,
        "vibration_y": row.vibration_y,
        "vibration_z": row.vibration_z,
        "vibration_rms": row.vibration_rms,
        "altitude": row.altitude,
        "latitude": row.latitude,
        "longitude": row.longitude,
    }


def serialize_uav(u: UAV) -> dict:
    return {
        "uav_id": u.uav_id,
        "name": u.name,
        "model": u.model,
        "registered_at": u.registered_at.isoformat() if u.registered_at else None,
        "pending_command": u.pending_command or "NONE",
        "command_lat": u.command_lat,
        "command_lon": u.command_lon,
    }


def serialize_inventory(i: InventoryItem) -> dict:
    return {
        "id": i.id,
        "query": i.query,
        "title": i.title,
        "description": i.description,
        "image_url": i.image_url,
        "source_url": i.source_url,
        "quantity": i.quantity,
        "added_at": i.added_at.isoformat() if i.added_at else None,
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.post("/api/uavs/register")
def register_uav(payload: UAVRegister, db: Session = Depends(get_db)):
    existing = db.query(UAV).filter(UAV.uav_id == payload.uav_id).first()
    if existing:
        existing.name = payload.name or existing.name
        existing.model = payload.model or existing.model
        db.commit()
        return {"status": "updated", "uav_id": existing.uav_id}
    uav = UAV(uav_id=payload.uav_id, name=payload.name, model=payload.model)
    db.add(uav)
    db.commit()
    return {"status": "registered", "uav_id": uav.uav_id}


@app.get("/api/uavs")
def list_uavs(db: Session = Depends(get_db)):
    uavs = db.query(UAV).all()
    result = []
    for u in uavs:
        latest = (
            db.query(Telemetry)
            .filter(Telemetry.uav_id == u.uav_id)
            .order_by(Telemetry.timestamp.desc())
            .first()
        )
        entry = serialize_uav(u)
        entry["latest"] = serialize_telemetry(latest) if latest else None
        entry["alert"] = evaluate_alert(latest)
        result.append(entry)
    return result


@app.post("/api/uavs/{uav_id}/telemetry")
def add_telemetry(uav_id: str, payload: TelemetryIn, db: Session = Depends(get_db)):
    # auto-register UAV on first data push, so a new drone "just works"
    uav = db.query(UAV).filter(UAV.uav_id == uav_id).first()
    if not uav:
        uav = UAV(uav_id=uav_id, name=uav_id)
        db.add(uav)
        db.commit()

    vibration_rms = None
    if None not in (payload.vibration_x, payload.vibration_y, payload.vibration_z):
        vibration_rms = (
            payload.vibration_x ** 2 + payload.vibration_y ** 2 + payload.vibration_z ** 2
        ) ** 0.5

    entry = Telemetry(
        uav_id=uav_id,
        timestamp=payload.timestamp or datetime.utcnow(),
        battery_voltage=payload.battery_voltage,
        current=payload.current,
        soc=payload.soc,
        soh=payload.soh,
        temperature=payload.temperature,
        vibration_x=payload.vibration_x,
        vibration_y=payload.vibration_y,
        vibration_z=payload.vibration_z,
        vibration_rms=vibration_rms,
        altitude=payload.altitude,
        latitude=payload.latitude,
        longitude=payload.longitude,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)

    alert = evaluate_alert(entry)
    # Auto-trigger: if this reading crosses a critical threshold, tell the
    # drone to return to launch, unless an operator already set a command.
    if alert["level"] == "critical" and uav.pending_command in (None, "NONE"):
        uav.pending_command = "RTL"
        db.commit()

    return {
        "status": "ok",
        "id": entry.id,
        "vibration_rms": vibration_rms,
        "alert": alert,
        "pending_command": uav.pending_command,
    }


@app.get("/api/uavs/{uav_id}/telemetry")
def get_telemetry(uav_id: str, limit: int = 200, db: Session = Depends(get_db)):
    rows = (
        db.query(Telemetry)
        .filter(Telemetry.uav_id == uav_id)
        .order_by(Telemetry.timestamp.desc())
        .limit(limit)
        .all()
    )
    rows.reverse()  # chronological order for charting
    return [serialize_telemetry(r) for r in rows]


@app.get("/api/uavs/{uav_id}/latest")
def get_latest(uav_id: str, db: Session = Depends(get_db)):
    row = (
        db.query(Telemetry)
        .filter(Telemetry.uav_id == uav_id)
        .order_by(Telemetry.timestamp.desc())
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="No telemetry yet for this UAV")
    result = serialize_telemetry(row)
    result["alert"] = evaluate_alert(row)
    return result


@app.get("/api/uavs/{uav_id}/command")
def get_command(uav_id: str, db: Session = Depends(get_db)):
    """Polled by the companion computer (e.g. Jetson) to check whether it
    should RTL, hold, fly to a point, or do nothing right now."""
    uav = db.query(UAV).filter(UAV.uav_id == uav_id).first()
    if not uav:
        raise HTTPException(status_code=404, detail="UAV not found")
    return {
        "uav_id": uav_id,
        "command": uav.pending_command or "NONE",
        "lat": uav.command_lat,
        "lon": uav.command_lon,
    }


@app.post("/api/uavs/{uav_id}/command")
def set_command(uav_id: str, payload: CommandIn, db: Session = Depends(get_db)):
    """Set manually -- e.g. from the Commanding card on the dashboard, or to
    clear a command back to NONE once the companion computer has acted on it."""
    if payload.command not in ("NONE", "RTL", "HOLD", "GOTO"):
        raise HTTPException(status_code=400, detail="command must be NONE, RTL, HOLD, or GOTO")
    if payload.command == "GOTO" and (payload.lat is None or payload.lon is None):
        raise HTTPException(status_code=400, detail="GOTO requires both lat and lon")
    if payload.lat is not None and not (-90 <= payload.lat <= 90):
        raise HTTPException(status_code=400, detail="lat must be between -90 and 90")
    if payload.lon is not None and not (-180 <= payload.lon <= 180):
        raise HTTPException(status_code=400, detail="lon must be between -180 and 180")

    uav = db.query(UAV).filter(UAV.uav_id == uav_id).first()
    if not uav:
        raise HTTPException(status_code=404, detail="UAV not found")

    uav.pending_command = payload.command
    if payload.command == "GOTO":
        uav.command_lat = payload.lat
        uav.command_lon = payload.lon
    else:
        uav.command_lat = None
        uav.command_lon = None
    db.commit()
    return {
        "uav_id": uav_id,
        "command": uav.pending_command,
        "lat": uav.command_lat,
        "lon": uav.command_lon,
    }


# ---------------------------------------------------------------------------
# Inventory routes
# ---------------------------------------------------------------------------

@app.post("/api/inventory/lookup")
def inventory_lookup(payload: InventoryLookupIn):
    """Look up a typed component/model name on the web and return a
    best-effort title, description, image, and source link. Does not save
    anything -- used to show a live preview while the operator types."""
    return lookup_component(payload.query)


@app.get("/api/inventory")
def list_inventory(db: Session = Depends(get_db)):
    items = db.query(InventoryItem).order_by(InventoryItem.added_at.desc()).all()
    return [serialize_inventory(i) for i in items]


@app.post("/api/inventory")
def add_inventory(payload: InventoryAddIn, db: Session = Depends(get_db)):
    # If the caller already has looked-up details (from the preview step),
    # trust them and skip a second search. Otherwise, look it up now.
    data = {}
    if payload.title is None and payload.image_url is None:
        data = lookup_component(payload.query)

    item = InventoryItem(
        query=payload.query,
        title=payload.title or data.get("title") or payload.query,
        description=payload.description or data.get("description"),
        image_url=payload.image_url or data.get("image_url"),
        source_url=payload.source_url or data.get("source_url"),
        quantity=payload.quantity if payload.quantity is not None else 1,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return serialize_inventory(item)


@app.patch("/api/inventory/{item_id}")
def update_inventory(item_id: int, payload: InventoryUpdateIn, db: Session = Depends(get_db)):
    item = db.query(InventoryItem).filter(InventoryItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    if payload.quantity is not None:
        if payload.quantity < 0:
            raise HTTPException(status_code=400, detail="quantity cannot be negative")
        item.quantity = payload.quantity
    db.commit()
    db.refresh(item)
    return serialize_inventory(item)


@app.delete("/api/inventory/{item_id}")
def delete_inventory(item_id: int, db: Session = Depends(get_db)):
    item = db.query(InventoryItem).filter(InventoryItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    db.delete(item)
    db.commit()
    return {"status": "deleted"}


@app.delete("/api/uavs/{uav_id}")
def delete_uav(uav_id: str, db: Session = Depends(get_db)):
    uav = db.query(UAV).filter(UAV.uav_id == uav_id).first()
    if not uav:
        raise HTTPException(status_code=404, detail="UAV not found")
    db.delete(uav)
    db.commit()
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Serve the dashboard frontend as static files
# ---------------------------------------------------------------------------
frontend_path = os.path.join(BASE_DIR, "..", "frontend")
if os.path.isdir(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")