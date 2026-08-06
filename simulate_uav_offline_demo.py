"""
Demo script: simulates a UAV that goes offline for a stretch (like flying out
of Wi-Fi/4G range), buffers its readings locally during the outage, then
reconnects and sends the backlog -- so you can watch the dashboard chart show
a gap, then catch up, proving no data is lost during a real dropout.

Usage:
    python simulate_uav_offline_demo.py --uav-id UAV-01 \
        --outage-at 10 --outage-duration 15

This means: send normally for 10 seconds, go "offline" for 15 seconds
(buffering locally instead of sending), then reconnect and flush everything.

Watch http://localhost:8000 while this runs -- select the UAV, and you'll see
the charts pause during the outage window, then jump forward all at once as
the backlog gets sent.
"""

import argparse
import json
import math
import os
import random
import time
from datetime import datetime, timezone

import requests

BUFFER_FILE = "demo_unsent_telemetry.jsonl"


def simulate_step(state):
    state["soc"] = max(0.0, state["soc"] - random.uniform(0.05, 0.25))
    state["voltage"] = 22.2 * (state["soc"] / 100.0) + random.uniform(-0.15, 0.15) + 3.0
    state["current"] = max(0.0, 8 + random.uniform(-1.5, 3.5))
    state["temperature"] = 28 + (100 - state["soc"]) * 0.06 + random.uniform(-0.5, 0.5)

    t = state["t"]
    state["vib_x"] = 0.05 + 0.02 * math.sin(t / 3.0) + random.uniform(-0.01, 0.01)
    state["vib_y"] = 0.05 + 0.02 * math.cos(t / 4.0) + random.uniform(-0.01, 0.01)
    state["vib_z"] = 0.08 + 0.015 * math.sin(t / 2.0) + random.uniform(-0.01, 0.01)
    state["t"] += 1
    return state


def make_payload(state):
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "battery_voltage": round(state["voltage"], 2),
        "current": round(state["current"], 2),
        "soc": round(state["soc"], 1),
        "soh": round(state["soh"], 1),
        "temperature": round(state["temperature"], 1),
        "vibration_x": round(state["vib_x"], 4),
        "vibration_y": round(state["vib_y"], 4),
        "vibration_z": round(state["vib_z"], 4),
    }


def buffer_reading(payload):
    with open(BUFFER_FILE, "a") as f:
        f.write(json.dumps(payload) + "\n")


def flush_buffer(url, uav_id):
    if not os.path.exists(BUFFER_FILE):
        return 0
    with open(BUFFER_FILE, "r") as f:
        lines = f.readlines()
    sent = 0
    for line in lines:
        payload = json.loads(line)
        requests.post(f"{url}/api/uavs/{uav_id}/telemetry", json=payload, timeout=5)
        sent += 1
    os.remove(BUFFER_FILE)
    return sent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:8000")
    parser.add_argument("--uav-id", default="UAV-01")
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--outage-at", type=float, default=10, help="Seconds before simulated outage starts")
    parser.add_argument("--outage-duration", type=float, default=15, help="How long the outage lasts")
    parser.add_argument("--total-duration", type=float, default=60, help="Total demo runtime")
    args = parser.parse_args()

    requests.post(f"{args.url}/api/uavs/register", json={
        "uav_id": args.uav_id, "name": args.uav_id, "model": "Offline-Demo Drone"
    }, timeout=5)
    print(f"Registered {args.uav_id}. Demo starting -- watch the dashboard now.")

    state = {"soc": 100.0, "soh": 95.0, "voltage": 25.2, "current": 8.0,
              "temperature": 28.0, "vib_x": 0.05, "vib_y": 0.05, "vib_z": 0.08, "t": 0}

    start = time.time()
    outage_started = False
    outage_ended = False

    while time.time() - start < args.total_duration:
        elapsed = time.time() - start
        state = simulate_step(state)
        payload = make_payload(state)

        in_outage = args.outage_at <= elapsed < (args.outage_at + args.outage_duration)

        if in_outage:
            if not outage_started:
                print(f"\n--- Simulated network dropout starting (t={elapsed:.0f}s) ---")
                print("--- Readings will buffer locally instead of reaching the dashboard ---\n")
                outage_started = True
            buffer_reading(payload)
            print(f"[BUFFERED - offline] SoC={payload['soc']}%  V={payload['battery_voltage']}")
        else:
            if outage_started and not outage_ended:
                print(f"\n--- Connection restored (t={elapsed:.0f}s) -- flushing backlog ---")
                sent = flush_buffer(args.url, args.uav_id)
                print(f"--- Sent {sent} buffered reading(s). Watch the dashboard catch up. ---\n")
                outage_ended = True

            try:
                requests.post(f"{args.url}/api/uavs/{args.uav_id}/telemetry", json=payload, timeout=5)
                print(f"[SENT - live] SoC={payload['soc']}%  V={payload['battery_voltage']}")
            except requests.RequestException as e:
                print(f"Send failed unexpectedly: {e}")

        time.sleep(args.interval)

    print("\nDemo complete.")


if __name__ == "__main__":
    main()
