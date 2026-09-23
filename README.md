<p align="center">
  <img src="extension/images/icon-256.png" width="128" height="128" alt="Tab Mixer icon">
</p>

<h1 align="center">Tab Mixer</h1>

<p align="center">Per-tab volume and mute for Safari on macOS.</p>

Safari can mute a tab, but it can't turn one down. Tab Mixer adds a toolbar popup
with a volume slider for each tab, so the music in one tab can sit quietly under a
video or a call in another.

## Features

- **Volume slider per tab**, 0–100%, with a one-click **Reset** to 100%
- **Mute** any tab
- **On/off switch** — off plays every tab at normal volume and keeps your settings
- **All tabs** view, to set a tab's volume before it starts playing
- Works with regular media sites and web calls; tested on YouTube, **Google Meet** and **Zoom** in Safari
- Native macOS controls; follows light/dark mode and your accent color
- Nothing leaves your Mac: no network requests, no analytics

## Requirements

- macOS 14 (Sonoma) or later
- Safari 17 or later
- Xcode 15 or later, to build it

## Install (build from source)

1. Clone the repo and open `Tab Mixer/Tab Mixer.xcodeproj` in Xcode.
2. Select the project → **Signing & Capabilities**, and choose your own Apple ID
   team for **both** targets (`Tab Mixer` and `Tab Mixer Extension`). A free
   Apple ID works.
3. Choose the **Tab Mixer** scheme with **My Mac** as the destination and press **⌘R**.
4. In Safari: **Settings → Advanced → Show features for web developers**, then
   **Develop → Allow Unsigned Extensions**.
5. **Safari → Settings → Extensions**: enable **Tab Mixer** and allow it on all websites.

> **Why "Allow Unsigned Extensions"?** Apps signed with a free Apple ID aren't
> notarized, and Safari turns that setting off every time it quits, so you'll need
> to re-enable it after each Safari restart. A paid Apple Developer account
> (Developer ID signing + notarization) removes this step.

To keep it installed without Xcode, use **Product → Archive** (or build the
Release configuration), copy `Tab Mixer.app` to `/Applications`, and open it once.

## Usage

Click the Tab Mixer button in Safari's toolbar.

- Tabs playing audio show a blue dot. Tick **All tabs** to list silent tabs too.
- Drag a slider to set that tab's volume; **Reset** returns it to 100%.
- The switch next to the title turns the whole mixer off and on.

Settings apply per tab and last until the tab is closed.

## How it works

The extension wraps the page's audio APIs from inside the page:

- `<audio>`/`<video>` elements — the page keeps seeing the volume it set, while the
  real volume is scaled by the tab's level. This covers WebRTC calls, whose remote
  audio plays through media elements.
- **Web Audio** — anything connected to an `AudioContext`'s output is routed
  through one gain node per context.

The slider uses a squared taper (50% ≈ a quarter of the amplitude), which sounds
more even than a linear one.

| Path | Role |
| --- | --- |
| `extension/inject.js` | Runs in the page; hooks media elements and Web Audio |
| `extension/bridge.js` | Content script; relays state between the page and the extension |
| `extension/background.js` | Stores per-tab settings and the on/off switch |
| `extension/popup.*` | The toolbar popup |
| `Tab Mixer/` | Xcode project: the host app and the Safari extension wrapper |
| `tools/` | `logs.sh` (read the log) and `make_icons.py` (regenerate icons) |

## Known limitations

- **Tab groups:** Safari only lets extensions see tabs in the tab group that's
  open in each window.
- **Only Safari tabs:** it can't affect desktop apps (e.g. the Zoom app) or sites
  added to the Dock as web apps.
- **What you hear only:** muting a call tab doesn't mute your microphone.

## Debugging

Warnings and errors are written to the macOS unified log:

```sh
tools/logs.sh           # last 10 minutes
tools/logs.sh follow    # live
tools/logs.sh errors    # errors only
```

Set `VERBOSE = true` at the top of each file in `extension/` to log every event,
and use the popup's **Dump** button to log a full state snapshot.

## Icons

All icons are drawn by a script. After changing it, run:

```sh
python3 tools/make_icons.py   # needs Pillow: pip3 install pillow
```

## License

[MIT](LICENSE)
