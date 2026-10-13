// Read Aloud - offscreen audio player for remote TTS.
// Plays a queue of audio chunks/URLs sequentially with pause/resume/stop support.

// Log locally AND relay to the background service worker console, which is much
// easier to reach (chrome://extensions -> "Inspect views: service worker").
function diag(msg) {
  console.warn(msg);
  chrome.runtime.sendMessage({ type: "diag", msg }).catch(() => {});
}

let audio = null;
let queue = [];
let index = 0;
let session = 0; // bump to invalidate an in-flight queue

const VOXCPM2_VOICE = "voxcpm2-neutral";
const VOXCPM2_SPACE = "https://soemintheinsmt6-myanmar-voxcpm2.hf.space";
const VOXCPM2_VOICE_DESCRIPTION =
  "A calm adult Burmese speaker with a neutral, warm, " +
  "natural human voice and clear pronunciation";

let hfToken = "";

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  switch (msg.type) {
    case "offscreen-play":
      hfToken = msg.hfToken || "";
      if (msg.queue) {
        startQueue(msg.queue, msg.rate, msg.pitch, msg.volume);
      } else {
        startLegacy(msg.urls, msg.rate, msg.volume);
      }
      break;
    case "offscreen-pause":
      audio?.pause();
      break;
    case "offscreen-resume":
      audio?.play().catch(() => {});
      break;
    case "offscreen-stop":
      stop();
      break;
  }
});

function startQueue(q, rate, pitch, volume) {
  stop();
  queue = q;
  index = 0;
  playNextQueue(++session, rate, pitch, volume);
}

function startLegacy(urls, rate, volume) {
  stop();
  queue = urls.map(url => ({ url }));
  index = 0;
  playNextLegacy(++session, rate, volume);
}

async function playNextQueue(mySession, rate, pitch, volume) {
  if (mySession !== session) return;
  if (index >= queue.length) {
    done();
    return;
  }

  const item = queue[index++];
  if (item.voice) {
    try {
      let blob;
      let applyPlaybackRate = false;
      if (item.voice === VOXCPM2_VOICE) {
        try {
          blob = await synthesizeVoxCPM2(item.text);
          applyPlaybackRate = true;
        } catch (err) {
          diag(`VoxCPM2 failed, trying the Myanmar cloud voice: ${err?.message || err}`);
          blob = await synthesizeNeural(
            item.text,
            "my-MM-ThihaNeural",
            rate,
            pitch
          );
        }
      } else {
        blob = await synthesizeNeural(item.text, item.voice, rate, pitch);
      }
      if (mySession !== session) return;

      const blobUrl = URL.createObjectURL(blob);
      audio = new Audio(blobUrl);
      // Cloud rate/pitch are baked into SSML. VoxCPM returns plain WAV audio,
      // so apply the speed locally while preserving the generated pitch.
      audio.playbackRate = applyPlaybackRate ? rate : 1;
      audio.preservesPitch = true;
      audio.volume = volume;
      audio.onended = () => {
        URL.revokeObjectURL(blobUrl);
        playNextQueue(mySession, rate, pitch, volume);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        diag(
          `Neural TTS audio error (mediaError=${audio?.error?.code}, ` +
          `blob ${blob.size}B ${blob.type}), falling back to Google Translate`
        );
        playGoogleFallback(item.text, item.lang, mySession, rate, pitch, volume);
      };
      audio.play().catch((err) => {
        URL.revokeObjectURL(blobUrl);
        diag(`Neural TTS play() rejected: ${err?.name} ${err?.message}`);
        playGoogleFallback(item.text, item.lang, mySession, rate, pitch, volume);
      });
    } catch (err) {
      diag(`Neural TTS synthesis failed, falling back to Google Translate: ${err?.message || err}`);
      playGoogleFallback(item.text, item.lang, mySession, rate, pitch, volume);
    }
  } else {
    playGoogleFallback(item.text, item.lang, mySession, rate, pitch, volume);
  }
}

// The Hugging Face ZeroGPU Space speaks Gradio's queue API: POST the inputs to
// get an event id, read the server-sent event stream until "complete", then
// download the generated WAV file it points to.
async function synthesizeVoxCPM2(text) {
  const controller = new AbortController();
  // ZeroGPU may need to wake the Space and wait in the GPU queue first.
  const timeoutId = setTimeout(() => controller.abort(), 300000);
  // Anonymous ZeroGPU calls get almost no quota; the token bills the user's own.
  // Like gradio_client, send it as X-HF-Authorization: ZeroGPU ignores a plain
  // Authorization header on public Spaces.
  const auth = hfToken ? { "X-HF-Authorization": `Bearer ${hfToken}` } : {};
  const callUrl = `${VOXCPM2_SPACE}/gradio_api/call/tts`;
  try {
    const submit = await fetch(callUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ data: [text, VOXCPM2_VOICE_DESCRIPTION] }),
      signal: controller.signal,
    });
    if (!submit.ok) {
      const detail = (await submit.text()).slice(0, 300);
      throw new Error(`HTTP ${submit.status}${detail ? `: ${detail}` : ""}`);
    }
    const { event_id: eventId } = await submit.json();
    if (!eventId) throw new Error("The Space did not return an event id");

    const stream = await fetch(`${callUrl}/${eventId}`, {
      headers: auth,
      signal: controller.signal,
    });
    if (!stream.ok) throw new Error(`HTTP ${stream.status} while waiting for the result`);
    const file = parseGradioResult(await stream.text());

    const fileUrl = file.url || `${VOXCPM2_SPACE}/gradio_api/file=${file.path}`;
    const res = await fetch(fileUrl, { headers: auth, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} while downloading the audio`);
    const blob = await res.blob();
    if (blob.size < 200) throw new Error("The Space returned empty audio");
    await assertDecodable(blob);
    return blob;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("The Space took longer than 5 minutes");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Returns the output FileData from a finished Gradio event stream, or throws
// the Space's error message (e.g. "ZeroGPU quota exceeded").
function parseGradioResult(body) {
  for (const block of body.split(/\r?\n\r?\n/)) {
    const event = block.match(/^event: *(.*)$/m)?.[1]?.trim();
    const data = block.match(/^data: *(.*)$/m)?.[1];
    if (event === "complete") {
      const file = JSON.parse(data)?.[0];
      if (!file?.path && !file?.url) throw new Error("The Space returned no audio file");
      return file;
    }
    if (event === "error") {
      let message = "The Space reported an error";
      try {
        const parsed = JSON.parse(data);
        message = parsed?.error || parsed?.title || message;
      } catch {}
      throw new Error(message);
    }
  }
  throw new Error("The Space closed the stream without a result");
}

// Try the neural backends in the order most likely to succeed for this browser.
// The Edge WebSocket endpoint 403s any handshake without a recent "Edg/" User-Agent,
// and Chrome offers no way to change the UA on a WebSocket — so on non-Edge browsers
// Bing Translator TTS (same Azure neural voices, plain fetch) is the primary.
const IS_EDGE_BROWSER = /\bEdg\//.test(navigator.userAgent);

async function synthesizeNeural(text, voice, rate, pitch) {
  // Bing twice: a failure clears the cached session, so the second attempt
  // runs with a freshly fetched token (heals expired/region-bound tokens).
  const backends = IS_EDGE_BROWSER
    ? [synthesizeChunk, synthesizeBingChunk, synthesizeBingChunk]
    : [synthesizeBingChunk, synthesizeBingChunk, synthesizeChunk];
  let lastErr;
  for (const backend of backends) {
    try {
      return await backend(text, voice, rate, pitch);
    } catch (err) {
      lastErr = err;
      diag(`Neural backend ${backend.name} failed: ${err?.message || err}`);
    }
  }
  throw lastErr;
}

// Reject blobs the browser can't actually decode, so a bad response falls
// through to the next backend instead of erroring at playback time.
async function assertDecodable(blob) {
  const ctx = new AudioContext();
  try {
    await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    ctx.close().catch(() => {});
  }
}

function playGoogleFallback(text, lang, mySession, rate, pitch, volume) {
  if (mySession !== session) return;
  const url = "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob" +
    `&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(text)}`;
  audio = new Audio(url);
  audio.playbackRate = rate;
  audio.volume = volume;
  audio.onended = () => playNextQueue(mySession, rate, pitch, volume);
  audio.onerror = () => playNextQueue(mySession, rate, pitch, volume);
  audio.play().catch(() => playNextQueue(mySession, rate, pitch, volume));
}

function playNextLegacy(mySession, rate, volume) {
  if (mySession !== session) return;
  if (index >= queue.length) {
    done();
    return;
  }
  const item = queue[index++];
  audio = new Audio(item.url);
  audio.playbackRate = rate;
  audio.volume = volume;
  audio.onended = () => playNextLegacy(mySession, rate, volume);
  audio.onerror = () => playNextLegacy(mySession, rate, volume);
  audio.play().catch(() => playNextLegacy(mySession, rate, volume));
}

function stop() {
  session++;
  if (audio) {
    audio.pause();
    audio.src = "";
    audio = null;
  }
  queue = [];
  index = 0;
}

function done() {
  audio = null;
  chrome.runtime.sendMessage({ type: "offscreen-done" }).catch(() => {});
}

// ---- Bing Translator TTS (Azure neural voices over plain fetch) ----

let bingSession = null; // { ig, key, token, expiresAt }

async function getBingSession() {
  if (bingSession && Date.now() < bingSession.expiresAt) return bingSession;
  // Some regions serve different markup on the bare URL; pin the market as a retry.
  const urls = [
    "https://www.bing.com/translator",
    "https://www.bing.com/translator?mkt=en-US",
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Bing translator page: HTTP ${res.status}`);
      const html = await res.text();
      // params_AbusePreventionHelper = [<key>,"<token>",<lifetimeMs>]
      const helper = html.match(/params_AbusePreventionHelper\s*=\s*\[(\d+),"([^"]+)",(\d+)\]/);
      const ig = html.match(/IG\s*:\s*"([A-Fa-f0-9]+)"/);
      if (!helper || !ig) throw new Error(`Could not parse Bing TTS auth params (${url})`);
      bingSession = {
        key: helper[1],
        token: helper[2],
        ig: ig[1],
        expiresAt: Date.now() + Math.min(Number(helper[3]), 3600000) - 60000,
      };
      return bingSession;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function synthesizeBingChunk(text, voice, rate, pitch) {
  const s = await getBingSession();
  const locale = voice.split("-").slice(0, 2).join("-") || "en-US";
  const ssml =
    `<speak version='1.0' xml:lang='${locale}'>` +
    `<voice xml:lang='${locale}' name='${voice}'>` +
    `<prosody rate='${formatProsodyRate(rate)}' pitch='${formatProsodyPitch(pitch)}'>` +
    escapeXml(text) +
    `</prosody></voice></speak>`;
  const res = await fetch(
    `https://www.bing.com/tfettts?isVertical=1&IG=${s.ig}&IID=translator.5023.1`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ssml, token: s.token, key: s.key }).toString(),
    }
  );
  const type = res.headers.get("content-type") || "";
  if (!res.ok || !type.includes("audio")) {
    bingSession = null; // token likely expired — refetch next time
    throw new Error(`Bing TTS: HTTP ${res.status} (${type})`);
  }
  const blob = await res.blob();
  if (blob.size < 200) {
    bingSession = null;
    throw new Error("Bing TTS: empty audio response");
  }
  try {
    await assertDecodable(blob);
  } catch {
    bingSession = null;
    throw new Error(`Bing TTS: undecodable audio (${blob.size}B ${blob.type})`);
  }
  return blob;
}

// ---- Microsoft Edge TTS WebSocket Protocol Helpers ----

const WIN_EPOCH = 11644473600n;
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_VERSION = "1-143.0.3650.75"; // server rejects old version constants

async function generateSecMsGecToken() {
  const seconds = BigInt(Math.floor(Date.now() / 1000)) + WIN_EPOCH;
  const roundedSeconds = seconds - (seconds % 300n);
  // The hash input is Windows FILETIME ticks (100ns units), NOT seconds —
  // hashing seconds makes the server reject the handshake with 403.
  const ticks = roundedSeconds * 10_000_000n;
  const strToHash = ticks.toString() + TRUSTED_CLIENT_TOKEN;

  const encoder = new TextEncoder();
  const data = encoder.encode(strToHash);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function connectId() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  array[6] = (array[6] & 0x0f) | 0x40;
  array[8] = (array[8] & 0x3f) | 0x80;
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatProsodyRate(rate) {
  const percentage = Math.round((rate - 1.0) * 100);
  return percentage >= 0 ? `+${percentage}%` : `${percentage}%`;
}

function formatProsodyPitch(pitch) {
  const percentage = Math.round((pitch - 1.0) * 100);
  return percentage >= 0 ? `+${percentage}%` : `${percentage}%`;
}

async function synthesizeChunk(text, voice, rate, pitch, volume) {
  const secMsGec = await generateSecMsGecToken();
  const connectionId = connectId();
  const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&ConnectionId=${connectionId}` +
    `&Sec-MS-GEC=${secMsGec}` +
    `&Sec-MS-GEC-Version=${CHROMIUM_VERSION}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    const audioChunks = [];
    let isDone = false;
    // Inactivity timeout: resets on every message so long chunks aren't cut off.
    let timeoutId;
    const armTimeout = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        ws.close();
        reject(new Error("WebSocket handshake / synthesis timeout"));
      }, 10000);
    };
    armTimeout();

    ws.onopen = () => {
      const timestamp = new Date().toISOString();
      const configMsg = 
        `Path: speech.config\r\n` +
        `Content-Type: application/json; charset=utf-8\r\n` +
        `X-Timestamp: ${timestamp}\r\n\r\n` +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                outputFormat: "audio-24khz-48kbitrate-mono-mp3",
                metadataType: "media"
              }
            }
          }
        });
      ws.send(configMsg);

      const formattedRate = formatProsodyRate(rate);
      const formattedPitch = formatProsodyPitch(pitch);
      const formattedVolume = "+0%"; // volume is handled on the audio element

      const escapedText = escapeXml(text);
      // Derive locale from the voice name, e.g. "my-MM-NilarNeural" -> "my-MM"
      const locale = voice.split("-").slice(0, 2).join("-") || "en-US";
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${locale}'>` +
          `<voice name='${voice}'>` +
            `<prosody rate='${formattedRate}' pitch='${formattedPitch}' volume='${formattedVolume}'>` +
              `${escapedText}` +
            `</prosody>` +
          `</voice>` +
        `</speak>`;

      const ssmlMsg = 
        `Path: ssml\r\n` +
        `X-RequestId: ${connectionId}\r\n` +
        `X-Timestamp: ${timestamp}\r\n` +
        `Content-Type: application/ssml+xml\r\n\r\n` +
        ssml;
      ws.send(ssmlMsg);
    };

    ws.onmessage = (event) => {
      armTimeout();
      if (typeof event.data === "string") {
        // Server sends "Path:turn.end" (no space after the colon)
        if (/Path:\s*turn\.end/.test(event.data)) {
          isDone = true;
          ws.close();
        }
      } else if (event.data instanceof ArrayBuffer) {
        const view = new DataView(event.data);
        const headerLength = view.getUint16(0);
        const headerBytes = new Uint8Array(event.data, 2, headerLength);
        const headerString = new TextDecoder().decode(headerBytes);
        if (/Path:\s*audio/.test(headerString)) {
          const audioChunk = event.data.slice(headerLength + 2);
          if (audioChunk.byteLength > 0) audioChunks.push(audioChunk);
        }
      }
    };

    ws.onerror = () => {
      ws.close();
      // onclose fires next with the close code; let it settle the promise.
    };

    ws.onclose = (event) => {
      clearTimeout(timeoutId);
      if (audioChunks.length > 0) {
        const blob = new Blob(audioChunks, { type: "audio/mp3" });
        resolve(blob);
      } else {
        reject(new Error(
          `WebSocket closed without audio (code=${event.code}` +
          `${event.reason ? `, reason=${event.reason}` : ""}` +
          `, done=${isDone})`
        ));
      }
    };
  });
}
