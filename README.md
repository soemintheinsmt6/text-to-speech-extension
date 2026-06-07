# Read Aloud — Text to Speech Browser Extension

A Chrome extension (Manifest V3) that converts text to speech using the browser's built-in TTS engine, with an automatic online fallback for languages your OS has no voice for (Myanmar, Khmer, Lao, Sinhala, Amharic, Georgian, Armenian).

## Features

- **Right-click to read** — select text on any page, right-click → "Read aloud"
- **Myanmar (မြန်မာ) & other unsupported-script languages** — detected automatically by Unicode script and spoken with natural-sounding **Microsoft neural voices** (my-MM-Thiha/Nilar, plus Khmer, Lao, Sinhala, Amharic, Georgian, Armenian), with Google Translate TTS as fallback; everything else uses offline OS voices
- **Myanmar voice switcher in the right-click menu** — "Myanmar voice" → Thiha (male, default) or Nilar (female); no popup needed
- **Keyboard shortcuts** — `Alt+Shift+S` reads the current selection, `Alt+Shift+X` stops
- **Popup player** — paste any text, or grab the page selection with one click
- **Voice picker** — choose any voice installed on your system
- **Speed, pitch & volume controls** — settings persist via `chrome.storage.sync`
- **Pause / Resume / Stop** playback controls

## Install (developer mode)

1. Open Chrome and go to `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked** and select this `tts-extension` folder
4. Pin the extension and click the 🔊 icon to open the popup

Works the same way in Edge (`edge://extensions`) and other Chromium browsers.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest: permissions, commands, popup |
| `background.js` | Service worker: context menu, shortcuts, script detection, `chrome.tts` playback |
| `offscreen.html/js` | Offscreen audio player for the remote TTS fallback |
| `popup.html/css/js` | Popup UI: text input, voice/rate/pitch/volume, playback controls |
| `icons/` | Extension icons (16/48/128) |

## Notes

- Voices come from your OS (macOS has many built in; install more under System Settings → Accessibility → Spoken Content).
- Myanmar and the other fallback languages need an internet connection. Pick the male/female cloud voice in the popup's "Cloud Neural Voices" group; speed, pitch, and volume all work with them.
- The neural voices come from Bing Translator's TTS (Azure neural voices over plain HTTPS — works in any Chromium browser). On real Microsoft Edge, the Edge Read Aloud WebSocket endpoint is tried first. If both fail, playback falls back to Google Translate TTS.
- Note: the Edge WebSocket endpoint rejects connections whose User-Agent isn't a recent Microsoft Edge, and Chrome cannot alter the UA on WebSocket handshakes (not even via declarativeNetRequest) — that's why Bing Translator is the primary backend on Chrome.
- Reading the page selection doesn't work on restricted pages (`chrome://`, the Web Store) — paste text into the popup instead.
