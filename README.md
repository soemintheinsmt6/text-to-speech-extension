# Read Aloud — Text to Speech Browser Extension

A Chrome extension (Manifest V3) that converts text to speech using the browser's built-in TTS engine, with VoxCPM2 speech for Myanmar (hosted on a Hugging Face ZeroGPU Space) and an automatic online fallback for languages your OS has no voice for.

## Features

- **Right-click to read** — select text on any page, right-click → "Read aloud"
- **Myanmar (မြန်မာ)** — detected automatically and sent to a **VoxCPM2** Hugging Face ZeroGPU Space, with Microsoft/Google speech as fallback
- **Other unsupported-script languages** — spoken with Microsoft neural voices, with Google Translate TTS as fallback; everything else uses offline OS voices
- **Myanmar voice switcher in the right-click menu** — choose VoxCPM2 neutral, Thiha, or Nilar; no popup needed
- **Keyboard shortcuts** — `Alt+Shift+S` reads the current selection, `Alt+Shift+X` stops
- **Popup player** — paste any text, or grab the page selection with one click
- **Voice picker** — choose any voice installed on your system
- **Speed, pitch & volume controls** — settings persist via `chrome.storage.sync`
- **Pause / Resume / Stop** playback controls

## Install (developer mode)

1. Open Chrome and go to `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked** and select this repository folder
4. Pin the extension and click the 🔊 icon to open the popup

Works the same way in Edge (`edge://extensions`) and other Chromium browsers.

## VoxCPM2 setup for natural Myanmar speech

VoxCPM2 is a 2-billion-parameter PyTorch model, so it cannot run inside a
Chrome extension. The extension calls a Hugging Face **ZeroGPU** Space instead:
<https://soemintheinsmt6-myanmar-voxcpm2.hf.space>. To create your own Space,
follow [HUGGINGFACE_ZEROGPU_SETUP.md](HUGGINGFACE_ZEROGPU_SETUP.md) and change
`VOXCPM2_SPACE` in `offscreen.js` and the Space host in `manifest.json`
`host_permissions`.

### Add your Hugging Face token

ZeroGPU gives anonymous callers almost no GPU quota, so the extension sends your
token to have GPU time counted against your own account:

1. Create a **Read** token at <https://huggingface.co/settings/tokens>.
2. Click the extension icon, scroll to **Hugging Face token**, paste it, and
   click outside the field to save. It is kept in `chrome.storage.local` only
   and never synced.
3. Select **Myanmar - Neutral (VoxCPM2 Hugging Face)** and press Speak.

The token is sent as an `X-HF-Authorization` header, the same way
`gradio_client` does it; ZeroGPU ignores a plain `Authorization` header on
public Spaces.

### How the call works

`offscreen.js` uses Gradio's queue API:

1. `POST /gradio_api/call/tts` with `{"data": [text, voice_description]}`
   returns an `event_id`.
2. `GET /gradio_api/call/tts/<event_id>` streams events until `complete`
   (the generated WAV file) or `error`.
3. The WAV file is downloaded and played, with the popup's speed applied locally.

Text is sent in chunks of up to 500 characters, matching the Space's limit.

### Limits

- Free accounts get a small daily ZeroGPU allowance; long pages use it quickly.
- A sleeping Space can take a minute or more to wake up on the first request.
- Text you read with this voice is processed on Hugging Face infrastructure.
- If the Space fails for any reason (quota, timeout, error), Myanmar speech
  falls back to the Thiha cloud voice. Check the reason under
  `chrome://extensions` → **Inspect views: service worker**.

## Optional: local VoxCPM2 server

`server/app.py` is a localhost wrapper around `openbmb/VoxCPM2` for running the
model on your own GPU. The extension no longer calls it; switching back
requires pointing `offscreen.js` at `http://127.0.0.1:8765/tts` and restoring
that host in `manifest.json`.

Use Python 3.10–3.12 (3.11 is the safest choice). VoxCPM2 uses about 8 GB of
VRAM on an NVIDIA GPU. The current package also supports Apple MPS and CPU,
although these will usually be slower:

```bash
nvidia-smi
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r server/requirements.txt
python -m uvicorn server.app:app --host 127.0.0.1 --port 8765
```

`nvidia-smi` only applies to an NVIDIA machine; skip it on macOS. The server
defaults to `device="auto"` (CUDA, then MPS, then CPU) with model compilation
disabled for portability. On a compatible NVIDIA GPU, enable compilation with:

```bash
VOXCPM_DEVICE=cuda VOXCPM_OPTIMIZE=1 \
python -m uvicorn server.app:app --host 127.0.0.1 --port 8765
```

The first launch downloads the `openbmb/VoxCPM2` weights and can take several
minutes. You can verify the server separately:

```bash
curl http://127.0.0.1:8765/health
curl -X POST http://127.0.0.1:8765/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"မင်္ဂလာပါ။ နေကောင်းပါသလား။"}' \
  --output myanmar-test.wav
```

### Keep one consistent voice (recommended)

Without a reference clip, the server asks VoxCPM2 to design a calm, neutral
Burmese voice with a fixed generation seed. For the most consistent speaker,
use a short, clean recording that you own or have permission to use, together
with its exact transcript:

```bash
VOXCPM_REFERENCE_WAV=/absolute/path/to/speaker.wav \
VOXCPM_PROMPT_TEXT='အသံဖိုင်ထဲက မြန်မာစာကို အတိအကျ ထည့်ပါ။' \
python -m uvicorn server.app:app --host 127.0.0.1 --port 8765
```

To adjust the designed voice instead, set `VOXCPM_VOICE_DESCRIPTION` before
starting the server. Do not expose this unauthenticated development server to
the public internet.

### This Mac and remote GPU options

This machine is Apple Silicon but its system `python3` is 3.9, which is too old.
Install Python 3.11, create the virtual environment with that interpreter, and
let `VOXCPM_DEVICE=auto` select MPS:

```bash
brew install python@3.11
/opt/homebrew/bin/python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r server/requirements.txt
python -m uvicorn server.app:app --host 127.0.0.1 --port 8765
```

If MPS has a compatibility problem, retry with `VOXCPM_DEVICE=cpu`; it will be
much slower.

For a private Linux GPU host, keep the server bound to localhost and forward it
to the Mac instead of exposing an unauthenticated port:

```bash
ssh -N -L 8765:127.0.0.1:8765 user@gpu-host
```

The forwarded server is then reachable at `http://127.0.0.1:8765`.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest: permissions, commands, popup |
| `background.js` | Service worker: context menu, shortcuts, script detection, `chrome.tts` playback |
| `offscreen.html/js` | Offscreen audio player: VoxCPM2 Space client and cloud fallbacks |
| `popup.html/css/js` | Popup UI: text input, voice/rate/pitch/volume, Hugging Face token, playback controls |
| `server/` | Optional Python localhost wrapper around `openbmb/VoxCPM2` |
| `HUGGINGFACE_ZEROGPU_SETUP.md` | How to create the VoxCPM2 ZeroGPU Space |
| `icons/` | Extension icons (16/48/128) |

## Notes

- Voices come from your OS (macOS has many built in; install more under System Settings → Accessibility → Spoken Content).
- VoxCPM2 needs an internet connection, a running Hugging Face Space, and ZeroGPU quota. If it is unavailable, Myanmar speech falls back to the existing cloud voices automatically.
- The neural voices come from Bing Translator's TTS (Azure neural voices over plain HTTPS — works in any Chromium browser). On real Microsoft Edge, the Edge Read Aloud WebSocket endpoint is tried first. If both fail, playback falls back to Google Translate TTS.
- Note: the Edge WebSocket endpoint rejects connections whose User-Agent isn't a recent Microsoft Edge, and Chrome cannot alter the UA on WebSocket handshakes (not even via declarativeNetRequest) — that's why Bing Translator is the primary backend on Chrome.
- Reading the page selection doesn't work on restricted pages (`chrome://`, the Web Store) — paste text into the popup instead.
