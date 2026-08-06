"""
Runs ON the Jetson Nano (companion computer), mounted on the drone.

Reads real battery and vibration data from the Pixhawk flight controller over
MAVLink, and pushes it to your UAV Telemetry Backend so it shows up on the
dashboard — same API your simulate_uav.py script has been using, just with
real sensor values instead of fake ones.

Install on the Jetson:
    pip3 install pymavlink requests

Usage:
    python3 pixhawk_bridge.py --connection /dev/ttyACM0 --baud 57600 \
        --backend-url http://<your-backend-ip>:8000 --uav-id UAV-01

If your backend is deployed to the cloud, use its public URL instead of an IP.
"""

import argparse
import json
import os
import time
from datetime import datetime, timezone

import requests
from pymavlink import mavutil

# Readings that fail to send get appended here, then retried on the next
# successful connection -- so a temporary Wi-Fi/4G dropout doesn't lose data.
BUFFER_FILE = "unsent_telemetry.jsonl"


def connect_pixhawk(connection_str, baud):
    print(f"Connecting to Pixhawk on {connection_str} @ {baud}...")
    master = mavutil.mavlink_connection(connection_str, baud=baud)
    master.wait_heartbeat()
    print(f"Heartbeat received (system {master.target_system}, component {master.target_component})")
    return master


def buffer_reading(payload):
    """Save a reading locally when the backend can't be reached."""
    with open(BUFFER_FILE, "a") as f:
        f.write(json.dumps(payload) + "\n")


def flush_buffer(backend_url, uav_id):
    """Try to resend any readings saved while the connection was down."""
    if not os.path.exists(BUFFER_FILE):
        return
    remaining = []
    with open(BUFFER_FILE, "r") as f:
        lines = f.readlines()
    for line in lines:
        try:
            payload = json.loads(line)
            requests.post(f"{backend_url}/api/uavs/{uav_id}/telemetry", json=payload, timeout=5)
        except (requests.RequestException, json.JSONDecodeError):
            remaining.append(line)
    if remaining:
        with open(BUFFER_FILE, "w") as f:
            f.writelines(remaining)
        print(f"{len(remaining)} buffered reading(s) still unsent.")
    else:
        os.remove(BUFFER_FILE)
        print("Backlog cleared -- all buffered readings sent.")


def check_pending_command(backend_url, uav_id):
    """Ask the backend if it wants this drone to RTL or hold right now."""
    try:
        resp = requests.get(f"{backend_url}/api/uavs/{uav_id}/command", timeout=5)
        if resp.ok:
            return resp.json().get("command", "NONE")
    except requests.RequestException as e:
        print(f"Could not check pending command: {e}")
    return "NONE"


def clear_command(backend_url, uav_id):
    """Tell the backend we've acted on the command, so it doesn't repeat it."""
    try:
        requests.post(f"{backend_url}/api/uavs/{uav_id}/command",
                      json={"command": "NONE"}, timeout=5)
    except requests.RequestException:
        pass


def send_rtl(master):
    """Command the flight controller to Return To Launch."""
    print(">>> COMMANDING RETURN TO LAUNCH (RTL) <<<")
    master.mav.command_long_send(
        master.target_system, master.target_component,
        mavutil.mavlink.MAV_CMD_NAV_RETURN_TO_LAUNCH,
        0, 0, 0, 0, 0, 0, 0, 0
    )


def send_hold(master):
    """Command the flight controller to hold/loiter at the current position.
    This switches the flight mode to LOITER (ArduPilot) so the drone stays
    where it is instead of continuing its mission or returning."""
    print(">>> COMMANDING HOLD POSITION (LOITER) <<<")
    mode_id = master.mode_mapping().get("LOITER")
    if mode_id is not None:
        master.mav.set_mode_send(
            master.target_system,
            mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
            mode_id
        )
    else:
        print("LOITER mode not available on this flight controller/firmware.")


def estimate_soh(voltage, current, cycle_count=0):
    """
    Placeholder SoH estimate. Pixhawk/ArduPilot don't report a true State of
    Health value out of the box (that needs tracking discharge curves over
    many cycles). Replace this with your own model once you're logging
    enough flight history -- for now it returns a flat baseline so the field
    isn't empty, and you can improve it as your ML phase develops.
    """
    return 100.0  # TODO: replace with a real SoH model once you have flight history


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--connection", default="/dev/ttyACM0", help="Serial device for Pixhawk")
    parser.add_argument("--baud", type=int, default=57600)
    parser.add_argument("--backend-url", required=True, help="e.g. http://192.168.1.50:8000")
    parser.add_argument("--uav-id", required=True, help="e.g. UAV-01")
    parser.add_argument("--interval", type=float, default=2.0, help="Seconds between posts")
    args = parser.parse_args()

    master = connect_pixhawk(args.connection, args.baud)

    # Ask Pixhawk to stream the message types we need, at 2 Hz
    master.mav.request_data_stream_send(
        master.target_system, master.target_component,
        mavutil.mavlink.MAV_DATA_STREAM_ALL, 2, 1
    )

    latest = {
        "battery_voltage": None,
        "current": None,
        "soc": None,
        "vibration_x": None,
        "vibration_y": None,
        "vibration_z": None,
        "altitude": None,
        "latitude": None,
        "longitude": None,
    }

    last_post = 0

    print(f"Streaming telemetry for {args.uav_id} -> {args.backend_url}")

    while True:
        msg = master.recv_match(blocking=True, timeout=1)
        if msg is not None:
            mtype = msg.get_type()

            if mtype == "SYS_STATUS":
                # voltage in millivolts, current in centiamps, battery_remaining in %
                latest["battery_voltage"] = msg.voltage_battery / 1000.0
                latest["current"] = msg.current_battery / 100.0
                latest["soc"] = float(msg.battery_remaining) if msg.battery_remaining >= 0 else None

            elif mtype == "VIBRATION":
                latest["vibration_x"] = msg.vibration_x
                latest["vibration_y"] = msg.vibration_y
                latest["vibration_z"] = msg.vibration_z

            elif mtype == "GLOBAL_POSITION_INT":
                latest["latitude"] = msg.lat / 1e7
                latest["longitude"] = msg.lon / 1e7
                latest["altitude"] = msg.relative_alt / 1000.0  # mm -> m

        now = time.time()
        if now - last_post >= args.interval and latest["battery_voltage"] is not None:
            payload = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "battery_voltage": latest["battery_voltage"],
                "current": latest["current"],
                "soc": latest["soc"],
                "soh": estimate_soh(latest["battery_voltage"], latest["current"]),
                "vibration_x": latest["vibration_x"],
                "vibration_y": latest["vibration_y"],
                "vibration_z": latest["vibration_z"],
                "altitude": latest["altitude"],
                "latitude": latest["latitude"],
                "longitude": latest["longitude"],
            }
            try:
                resp = requests.post(
                    f"{args.backend_url}/api/uavs/{args.uav_id}/telemetry",
                    json=payload, timeout=5
                )
                print(f"Sent: SoC={payload['soc']}%  V={payload['battery_voltage']}  "
                      f"Vib=({payload['vibration_x']},{payload['vibration_y']},{payload['vibration_z']})")
                # connection is working -- try clearing any earlier backlog too
                flush_buffer(args.backend_url, args.uav_id)

                # The ingest response may already include an auto-triggered
                # command (e.g. backend detected a critical reading right now)
                if resp.ok:
                    auto_cmd = resp.json().get("pending_command", "NONE")
                    if auto_cmd == "RTL":
                        send_rtl(master)
                        clear_command(args.backend_url, args.uav_id)
                    elif auto_cmd == "HOLD":
                        send_hold(master)
                        clear_command(args.backend_url, args.uav_id)
            except requests.RequestException as e:
                print(f"Network unreachable, buffering reading locally: {e}")
                buffer_reading(payload)
            last_post = now

        # Also separately poll for a manually-issued command (e.g. operator
        # pressed "Force Return to Base" on the dashboard) -- independent of
        # whether a new telemetry reading was just sent.
        cmd = check_pending_command(args.backend_url, args.uav_id)
        if cmd == "RTL":
            send_rtl(master)
            clear_command(args.backend_url, args.uav_id)
        elif cmd == "HOLD":
            send_hold(master)
            clear_command(args.backend_url, args.uav_id)


if __name__ == "__main__":
    main()
