# Alma

A virtual pet with its own personality, memory and mood that lives in an EMO robot. When I go out it can move to my Galaxy Watch, and when I get back it returns to the robot with everything it lived through. Work in progress.

## Layout

- `core/`: the pet's brain in C (mood, energy, needs, personality, behavior selection). The same code runs on the robot and on the watch.
- `memory_store/`: long-term memory.
- `firmware/f2/`: ESP32 firmware (ESP-IDF). Sensors, gait, `.mot` player, K210 link, Wi-Fi, OTA.
- `relay/`: server (Python). Voice, vision, app, watch and robot arbiter (which body the pet is in).
- `android/`: Wear OS app, watch face, phone app and the core via NDK.
- `sim/`: simulator and tests for the core and memory.
- `catalog/`: catalog of animations and behaviors.
- `tools/`: face generator and `.mot` editors.
- `games/`: games for the app.

## What works (tested on the robot)

- Walks and explores on its own, cliff reflexes, struggles when picked up
- Touch sensors
- Face recognition: it knows me, and when it sees me the pet comes back from the watch
- Voice: wake word on the K210 → ESP32 records → server transcribes → command
- Uploading custom faces (`.avi`) to the K210
- Goes back to the home station on its own (laser + gyro) and gets off it
- OTA and debug logs over Wi-Fi
- Reacts to photos, tricks, alarms, food/care, sleep schedule
- Memory backed up on the server; moves to the watch and back

## Not working yet / not tested

- Climbing the ramp onto the station isn't reliable yet
- The distance sensor sometimes doesn't start at boot (retries added)
- Registering new faces and deleting old ones: written, not tested
- Battery is voltage only (no current reading)

## Not included

Wi-Fi and server credentials, API keys and the robot's original files (videos, sounds, `.mot`) are not in this repo. Credentials go in `firmware/f2/alma_dev_creds.h` (see `dev_creds.example.h`).

## License

Alma is licensed under the **GNU General Public License v3.0** (see `LICENSE`). You can use, modify and share it; if you
distribute a modified version, it must stay under the GPL-3.0 with its source available. Please credit the project.

Third-party parts keep their own licenses: the games in `games/` (MIT; `games/torres/` is AGPL-3.0) and cJSON in
`sim/third_party/cjson/` (MIT). `tools/caras/assets/sonidos/imperial_march.mp3` is not covered by this license.
