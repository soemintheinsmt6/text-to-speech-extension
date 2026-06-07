// Read Aloud - popup UI logic

const els = {
  text: document.getElementById("text"),
  grab: document.getElementById("grab"),
  voice: document.getElementById("voice"),
  rate: document.getElementById("rate"),
  pitch: document.getElementById("pitch"),
  volume: document.getElementById("volume"),
  rateVal: document.getElementById("rateVal"),
  pitchVal: document.getElementById("pitchVal"),
  volumeVal: document.getElementById("volumeVal"),
  speak: document.getElementById("speak"),
  pause: document.getElementById("pause"),
  stop: document.getElementById("stop"),
};

let paused = false;

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

init();

async function init() {
  await loadVoices();
  await restoreSettings();
  updateLabels();
  syncPlaybackState();

  // Pre-fill with the page's current selection, if any.
  chrome.runtime.sendMessage({ type: "getSelection" }, (res) => {
    if (res?.text && !els.text.value) els.text.value = res.text;
  });
}

function loadVoices() {
  return new Promise((resolve) => {
    chrome.tts.getVoices((voices) => {
      const frag = document.createDocumentFragment();
      const def = document.createElement("option");
      def.value = "";
      def.textContent = "System default";
      frag.appendChild(def);

      // Add Cloud Neural Voices group
      const cloudGroup = document.createElement("optgroup");
      cloudGroup.label = "Cloud Neural Voices (Natural)";
      Object.keys(CLOUD_VOICES).forEach((key) => {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = `${CLOUD_VOICES[key].name} (${CLOUD_VOICES[key].lang})`;
        cloudGroup.appendChild(opt);
      });
      frag.appendChild(cloudGroup);

      // Add Local System Voices group
      const localGroup = document.createElement("optgroup");
      localGroup.label = "System Voices";
      voices
        .filter((v) => v.voiceName)
        .sort((a, b) => (a.lang || "").localeCompare(b.lang || "") || a.voiceName.localeCompare(b.voiceName))
        .forEach((v) => {
          const opt = document.createElement("option");
          opt.value = v.voiceName;
          opt.textContent = v.lang ? `${v.voiceName} (${v.lang})` : v.voiceName;
          localGroup.appendChild(opt);
        });
      frag.appendChild(localGroup);

      els.voice.appendChild(frag);
      resolve();
    });
  });
}

async function restoreSettings() {
  const s = await chrome.storage.sync.get({ voiceName: "", rate: 1, pitch: 1, volume: 1 });
  els.voice.value = s.voiceName;
  if (els.voice.value !== s.voiceName) els.voice.value = ""; // saved voice no longer installed
  els.rate.value = s.rate;
  els.pitch.value = s.pitch;
  els.volume.value = s.volume;
}

function currentSettings() {
  return {
    voiceName: els.voice.value,
    rate: Number(els.rate.value),
    pitch: Number(els.pitch.value),
    volume: Number(els.volume.value),
  };
}

function saveSettings() {
  chrome.storage.sync.set(currentSettings());
}

function updateLabels() {
  els.rateVal.textContent = `${Number(els.rate.value).toFixed(1)}×`;
  els.pitchVal.textContent = Number(els.pitch.value).toFixed(1);
  els.volumeVal.textContent = `${Math.round(els.volume.value * 100)}%`;
}

function setPlaying(playing) {
  els.pause.disabled = !playing;
  els.stop.disabled = !playing;
  if (!playing) {
    paused = false;
    els.pause.textContent = "⏸ Pause";
  }
}

function syncPlaybackState() {
  chrome.runtime.sendMessage({ type: "status" }, (res) => {
    setPlaying(Boolean(res?.speaking));
  });
}

// ---- Events ----
[els.rate, els.pitch, els.volume].forEach((input) => {
  input.addEventListener("input", updateLabels);
  input.addEventListener("change", saveSettings);
});
els.voice.addEventListener("change", saveSettings);

els.grab.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "getSelection" }, (res) => {
    if (res?.text) els.text.value = res.text;
  });
});

els.speak.addEventListener("click", () => {
  const text = els.text.value.trim();
  if (!text) return;
  chrome.runtime.sendMessage({ type: "speak", text, settings: currentSettings() }, () => {
    setPlaying(true);
  });
});

els.pause.addEventListener("click", () => {
  paused = !paused;
  chrome.runtime.sendMessage({ type: paused ? "pause" : "resume" });
  els.pause.textContent = paused ? "▶ Resume" : "⏸ Pause";
});

els.stop.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "stop" });
  setPlaying(false);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "ttsDone") setPlaying(false);
});
