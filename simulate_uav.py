"""
UAV telemetry simulator.

Simulates one or more UAVs sending BMS + vibration data to the backend,
so you can test/demo the dashboard before wiring up real hardware.

Usage:
    python simulate_uav.py                      # simulate UAV-01 for 10 min
    python simulate_uav.py --uavs UAV-01 UAV-02 UAV-03   # simulate a fleet
    python simulate_uav.py --url http://192.168.1.50:8000 --interval 2
"""

import argparse
import math
import random
import time
from datetime import datetime, timezone

import requests


def simulate_step(state):
    """Advance one UAV's simulated battery/vibration/position state by one tick."""
    # Battery discharges slowly over the flight, with small noise
    state["soc"] = max(0.0, state["soc"] - random.uniform(0.05, 0.25))
    state["soh"] = max(70.0, state["soh"] - random.uniform(0, 0.002))  # degrades very slowly
    state["voltage"] = 22.2 * (state["soc"] / 100.0) + random.uniform(-0.15, 0.15) + 3.0
    state["current"] = max(0.0, 8 + random.uniform(-1.5, 3.5))
    state["temperature"] = 28 + (100 - state["soc"]) * 0.06 + random.uniform(-0.5, 0.5)

    t = state["t"]
    state["vib_x"] = 0.05 + 0.02 * math.sin(t / 3.0) + random.uniform(-0.01, 0.01)
    state["vib_y"] = 0.05 + 0.02 * math.cos(t / 4.0) + random.uniform(-0.01, 0.01)
    state["vib_z"] = 0.08 + 0.015 * math.sin(t / 2.0) + random.uniform(-0.01, 0.01)

    # Simulated GPS: fly a small circular loop around the UAV's base point,
    # so the map page has real, moving lat/lon/altitude to plot.
    radius_deg = 0.003  # roughly ~300m loop
    angle = t / 10.0
    state["lat"] = state["base_lat"] + radius_deg * math.sin(angle)
    state["lon"] = state["base_lon"] + radius_deg * math.cos(angle)
    state["alt"] = 30 + 5 * math.sin(t / 5.0)

    state["t"] += 1
    return state


def new_state(base_lat, base_lon):
    return {
        "soc": 100.0,
        "soh": random.uniform(92, 99),
        "voltage": 25.2,
        "current": 8.0,
        "temperature": 28.0,
        "vib_x": 0.05, "vib_y": 0.05, "vib_z": 0.08,
        "base_lat": base_lat, "base_lon": base_lon,
        "lat": base_lat, "lon": base_lon, "alt": 30.0,
        "t": 0,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:8000", help="Backend base URL")
    parser.add_argument("--uavs", nargs="+", default=["UAV-01"], help="UAV IDs to simulate")
    parser.add_argument("--interval", type=float, default=2.0, help="Seconds between readings")
    parser.add_argument("--duration", type=float, default=600, help="Total simulation seconds")
    args = parser.parse_args()

    # Base GPS location for the simulated fleet (Kochi, Kerala) -- each UAV
    # gets a slightly offset starting point so they don't overlap on the map.
    base_lat, base_lon = 9.9816, 76.2999
    states = {}
    for i, uav_id in enumerate(args.uavs):
        offset = i * 0.01  # ~1km apart
        states[uav_id] = new_state(base_lat + offset, base_lon + offset)

    # Register each UAV first
    for uav_id in args.uavs:
        try:
            requests.post(f"{args.url}/api/uavs/register", json={
                "uav_id": uav_id,
                "name": uav_id,
                "model": "Simulated Quadcopter",
            }, timeout=5)
            print(f"Registered {uav_id}")
        except requests.RequestException as e:
            print(f"Could not reach backend at {args.url}: {e}")
            return

    start = time.time()
    while time.time() - start < args.duration:
        for uav_id in args.uavs:
            s = simulate_step(states[uav_id])
            payload = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "battery_voltage": round(s["voltage"], 2),
                "current": round(s["current"], 2),
                "soc": round(s["soc"], 1),
                "soh": round(s["soh"], 1),
                "temperature": round(s["temperature"], 1),
                "vibration_x": round(s["vib_x"], 4),
                "vibration_y": round(s["vib_y"], 4),
                "vibration_z": round(s["vib_z"], 4),
                "altitude": round(s["alt"], 1),
                "latitude": round(s["lat"], 6),
                "longitude": round(s["lon"], 6),
            }
            try:
                requests.post(f"{args.url}/api/uavs/{uav_id}/telemetry", json=payload, timeout=5)
                print(f"[{uav_id}] SoC={payload['soc']}%  V={payload['battery_voltage']}  T={payload['temperature']}C")
            except requests.RequestException as e:
                print(f"[{uav_id}] send failed: {e}")

        time.sleep(args.interval)


if __name__ == "__main__":
    main()
