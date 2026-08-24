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


def simulate_step(state, command_info=None):
    """Advance one UAV's simulated battery/vibration/position state by one tick,
    reacting to GOTO, RTL, and HOLD commands received from the backend."""
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

    cmd = command_info.get("command", "NONE") if command_info else "NONE"
    target_lat = command_info.get("lat") if command_info else None
    target_lon = command_info.get("lon") if command_info else None

    # Handle Flight Modes based on active command
    if cmd == "HOLD":
        # Hover / loiter at current position
        state["alt"] = 30.0 + random.uniform(-0.2, 0.2)
    elif cmd == "RTL":
        # Return towards base launch point
        d_lat = state["base_lat"] - state["lat"]
        d_lon = state["base_lon"] - state["lon"]
        dist = math.hypot(d_lat, d_lon)
        if dist > 0.0001:
            step = min(0.0006, dist)
            state["lat"] += (d_lat / dist) * step
            state["lon"] += (d_lon / dist) * step
            state["alt"] = max(0.0, state["alt"] - 0.5)
        else:
            state["lat"] = state["base_lat"]
            state["lon"] = state["base_lon"]
            state["alt"] = 0.0  # Landed
    elif cmd == "GOTO" and target_lat is not None and target_lon is not None:
        # Fly towards the commanded destination point
        d_lat = target_lat - state["lat"]
        d_lon = target_lon - state["lon"]
        dist = math.hypot(d_lat, d_lon)
        if dist > 0.0001:
            step = min(0.0008, dist)  # Fly towards waypoint
            state["lat"] += (d_lat / dist) * step
            state["lon"] += (d_lon / dist) * step
            state["alt"] = 35.0 + random.uniform(-0.5, 0.5)
        else:
            state["lat"] = target_lat
            state["lon"] = target_lon
    else:
        # Default patrol trajectory: orbit around base point
        radius_deg = 0.003
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
            # Poll pending command from backend (GOTO, RTL, HOLD, NONE)
            cmd_info = None
            try:
                resp = requests.get(f"{args.url}/api/uavs/{uav_id}/command", timeout=3)
                if resp.ok:
                    cmd_info = resp.json()
            except requests.RequestException:
                pass

            s = simulate_step(states[uav_id], cmd_info)
            active_cmd = cmd_info.get("command", "NONE") if cmd_info else "NONE"

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
                cmd_tag = f" [CMD: {active_cmd}]" if active_cmd != "NONE" else ""
                print(f"[{uav_id}]{cmd_tag} Lat={payload['latitude']:.5f} Lon={payload['longitude']:.5f} SoC={payload['soc']}% Alt={payload['altitude']}m")
            except requests.RequestException as e:
                print(f"[{uav_id}] send failed: {e}")

        time.sleep(args.interval)


if __name__ == "__main__":
    main()
