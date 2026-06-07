// Read Aloud - background service worker
// Local voices play via chrome.tts. Languages with no local voice (e.g. Myanmar)
// fall back to Google Translate TTS, played through an offscreen document.

const DEFAULT_SETTINGS = {
  voiceName: "",
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
};

// Scripts that almost never have a local OS voice -> remote TTS language code.
// Detected by Unicode block.
const SCRIPT_LANGS = [
  { lang: "my", name: "Myanmar", re: /[က-႟ꩠ-ꩿꧠ-꧿]/ },
  { lang: "km", name: "Khmer", re: /[\u1780-\u17FF\u19E0-\u19FF]/ },
  { lang: "lo", name: "Lao", re: /[຀-໿]/ },
  { lang: "si", name: "Sinhala", re: /[඀-෿]/ },
  { lang: "am", name: "Amharic", re: /[ሀ-፿]/ },
  { lang: "ka", name: "Georgian", re: /[Ⴀ-ჿ]/ },
  { lang: "hy", name: "Armenian", re: /[԰-֏]/ },
];

const CLOUD_VOICES = {
  "my-MM-NilarNeural": { lang: "my", name: "Myanmar - Female (Cloud)" },
  "my-MM-ThihaNeural": { lang: "my", name: "Myanmar - Male (Cloud)" },
  "km-KH-SreymomNeural": { lang: "km", name: "Khmer - Female (Cloud)" },
  "km-KH-PisethNeural": { lang: "km", name: "Khmer - Male (Cloud)" },
  "lo-LA-KeomanyNeural": { lang: "lo", name: "Lao - Female (Cloud)" },
  "lo-LA-ChanthavongNeural": { lang: "lo", name: "Lao - Male (Cloud)" },
  "si-LK-ThiliniNeural": { lang: "si", name: "Sinhala - Female (Cloud)" },
  "si-LK-SameeraNeural": { lang: "si", name: "Sinhala - Male (Cloud)" },
  "am-ET-MekdesNeural": { lang: "am", name: "Amharic - Female (Cloud)" },
  "am-ET-AmehaNeural": { lang: "am", name: "Amharic - Male (Cloud)" },
  "ka-GE-EkaNeural": { lang: "ka", name: "Georgian - Female (Cloud)" },
  "ka-GE-GiorgiNeural": { lang: "ka", name: "Georgian - Male (Cloud)" },
  "hy-AM-AnahitNeural": { lang: "hy", name: "Armenian - Female (Cloud)" },
  "hy-AM-HaykNeural": { lang: "hy", name: "Armenian - Male (Cloud)" }
};

function getDefaultCloudVoice(lang) {
  switch (lang) {
    case "my": return "my-MM-ThihaNeural";
    case "km": return "km-KH-SreymomNeural";
    case "lo": return "lo-LA-KeomanyNeural";
    case "si": return "si-LK-ThiliniNeural";
    case "am": return "am-ET-MekdesNeural";
    case "ka": return "ka-GE-EkaNeural";
    case "hy": return "hy-AM-AnahitNeural";
    default: return "";
  }
}

// ---- Context menu ----
chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({
    id: "read-aloud",
    title: "Read aloud: \"%s\"",
    contexts: ["selection"],
  });
  chrome.contextMenus.create({
    id: "stop-reading",
    title: "Stop reading",
    contexts: ["all"],
  });
  // Voice switcher right in the context menu (works even without opening the popup)
  chrome.contextMenus.create({
    id: "voice-menu",
    title: "Myanmar voice",
    contexts: ["all"],
  });
  const { voiceName } = await chrome.storage.sync.get({ voiceName: "" });
  chrome.contextMenus.create({
    id: "voice-my-MM-ThihaNeural",
    parentId: "voice-menu",
    title: "Thiha (male) — default",
    type: "radio",
    checked: voiceName !== "my-MM-NilarNeural",
    contexts: ["all"],
  });
  chrome.contextMenus.create({
    id: "voice-my-MM-NilarNeural",
    parentId: "voice-menu",
    title: "Nilar (female)",
    type: "radio",
    checked: voiceName === "my-MM-NilarNeural",
    contexts: ["all"],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  const id = String(info.menuItemId);
  if (id === "read-aloud" && info.selectionText) {
    speak(info.selectionText);
  } else if (id === "stop-reading") {
    stopAll();
  } else if (id.startsWith("voice-my-")) {
    chrome.storage.sync.set({ voiceName: id.slice("voice-".length) });
  }
});

// ---- Keyboard shortcuts ----
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "stop-reading") {
    stopAll();
    return;
  }
  if (command === "read-selection") {
    const text = await getSelectionFromActiveTab();
    if (text) speak(text);
  }
});

async function getSelectionFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return "";
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection().toString(),
    });
    return results?.[0]?.result?.trim() ?? "";
  } catch {
    // Restricted page (chrome://, web store, etc.)
    return "";
  }
}

// ---- Messages from popup / offscreen ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case "speak":
      speak(msg.text, msg.settings);
      sendResponse({ ok: true });
      break;
    case "stop":
      stopAll();
      sendResponse({ ok: true });
      break;
    case "pause":
      chrome.tts.pause();
      sendOffscreen("offscreen-pause");
      sendResponse({ ok: true });
      break;
    case "resume":
      chrome.tts.resume();
      sendOffscreen("offscreen-resume");
      sendResponse({ ok: true });
      break;
    case "status":
      chrome.tts.isSpeaking((speaking) => {
        sendResponse({ speaking: speaking || remotePlaying });
      });
      return true; // async response
    case "getSelection":
      getSelectionFromActiveTab().then((text) => sendResponse({ text }));
      return true; // async response
    case "offscreen-done": // remote playback finished
      remotePlaying = false;
      chrome.runtime.sendMessage({ type: "ttsDone" }).catch(() => {});
      break;
    case "diag": // surfaced here because this console is the easiest to reach
      console.warn("[neural-tts]", msg.msg);
      break;
  }
});

let remotePlaying = false;

async function speak(text, settings) {
  if (!settings) {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    settings = { ...DEFAULT_SETTINGS, ...stored };
  }
  stopAll();

  const remote = detectRemoteLang(text);
  const cloud = CLOUD_VOICES[settings.voiceName];
  if (remote || cloud) {
    const lang = remote ? remote.lang : cloud.lang;
    // Use the chosen cloud voice only if it matches the detected language;
    // otherwise pick that language's default cloud voice.
    const voice =
      cloud && cloud.lang === lang ? settings.voiceName : getDefaultCloudVoice(lang);
    speakRemote(text, lang, voice, settings);
    return;
  }

  chrome.tts.speak(text, {
    voiceName: settings.voiceName || undefined,
    rate: clamp(Number(settings.rate) || 1, 0.1, 10),
    pitch: clamp(Number(settings.pitch) || 1, 0, 2),
    volume: clamp(Number(settings.volume) || 1, 0, 1),
    onEvent: (event) => {
      if (["end", "interrupted", "cancelled", "error"].includes(event.type)) {
        chrome.runtime.sendMessage({ type: "ttsDone" }).catch(() => {});
      }
    },
  });
}

function stopAll() {
  chrome.tts.stop();
  remotePlaying = false;
  sendOffscreen("offscreen-stop");
}

// Returns the SCRIPT_LANGS entry for the dominant script, if any.
// Counts marks too (Myanmar vowel signs/medials are \p{M}, not \p{L}), and
// triggers at >30% since the remote voice reads embedded English fine.
function detectRemoteLang(text) {
  const letters = [...text].filter((ch) => /[\p{L}\p{M}]/u.test(ch));
  if (!letters.length) return null;
  for (const entry of SCRIPT_LANGS) {
    const count = letters.filter((ch) => entry.re.test(ch)).length;
    if (count / letters.length > 0.3) return entry;
  }
  return null;
}

// ---- Remote TTS (Google Translate) via offscreen document ----

const CHUNK_LIMIT = 180; // translate_tts rejects long queries

async function speakRemote(text, lang, voice, settings) {
  const chunks = chunkText(text, 500); // 500 char limit for natural neural TTS phrasing
  const queue = chunks.map((chunk) => ({
    text: chunk,
    lang: lang,
    voice: voice
  }));

  await ensureOffscreen();
  remotePlaying = true;
  chrome.runtime.sendMessage({
    type: "offscreen-play",
    target: "offscreen",
    queue,
    rate: clamp(Number(settings.rate) || 1, 0.25, 4),
    pitch: clamp(Number(settings.pitch) || 1, 0.5, 2),
    volume: clamp(Number(settings.volume) || 1, 0, 1),
  }).catch(() => {
    remotePlaying = false;
  });
}

// Split on sentence boundaries (incl. Myanmar ။ and ၊), then spaces, never mid-word.
function chunkText(text, limit) {
  const sentences = text.split(/(?<=[။၊.!?;:\n])\s*/).filter((s) => s.trim());
  const chunks = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (let sentence of sentences) {
    while (sentence.length > limit) {
      // Hard-split an over-long sentence at the last space before the limit.
      let cut = sentence.lastIndexOf(" ", limit);
      if (cut < limit / 2) cut = limit;
      push();
      chunks.push(sentence.slice(0, cut).trim());
      sentence = sentence.slice(cut).trim();
    }
    if ((current + " " + sentence).trim().length > limit) push();
    current = (current + " " + sentence).trim();
  }
  push();
  return chunks;
}

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (!has) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play remote TTS audio for languages without a local voice",
    });
  }
}

function sendOffscreen(type) {
  chrome.runtime.sendMessage({ type, target: "offscreen" }).catch(() => {});
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
