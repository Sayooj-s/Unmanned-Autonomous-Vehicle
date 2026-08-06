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
    # "RTL" (return to launch), or "HOLD" (loiter in place). The companion
    # computer (e.g. Jetson) polls GET /api/uavs/{uav_id}/command and acts on
    # this, then the backend clears it back to "NONE" once issued.
    pending_command = Column(String, default="NONE")

    telemetry = relationship("Telemetry", back_populates="uav", cascade="all, delete-orphan")


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
    command: str  # "NONE", "RTL", or "HOLD"


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
    should RTL, hold, or do nothing right now."""
    uav = db.query(UAV).filter(UAV.uav_id == uav_id).first()
    if not uav:
        raise HTTPException(status_code=404, detail="UAV not found")
    return {"uav_id": uav_id, "command": uav.pending_command or "NONE"}


@app.post("/api/uavs/{uav_id}/command")
def set_command(uav_id: str, payload: CommandIn, db: Session = Depends(get_db)):
    """Set manually -- e.g. from a 'Force RTH' button on the dashboard, or to
    clear a command back to NONE once the companion computer has acted on it."""
    if payload.command not in ("NONE", "RTL", "HOLD"):
        raise HTTPException(status_code=400, detail="command must be NONE, RTL, or HOLD")
    uav = db.query(UAV).filter(UAV.uav_id == uav_id).first()
    if not uav:
        raise HTTPException(status_code=404, detail="UAV not found")
    uav.pending_command = payload.command
    db.commit()
    return {"uav_id": uav_id, "command": uav.pending_command}


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
