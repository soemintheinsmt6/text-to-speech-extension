# Host VoxCPM2 on Hugging Face ZeroGPU

This guide creates a free, lightweight VoxCPM2 service for Myanmar text-to-speech.

## Eligibility

Hugging Face Static Spaces cannot run VoxCPM2 because they only host frontend
HTML, CSS, and JavaScript. VoxCPM2 needs a **Gradio Space with ZeroGPU**.

A free personal account can host up to two ZeroGPU Spaces when all of these are
true:

- The email address is verified.
- The account is more than 30 days old.
- The account is in good standing.
- The Space belongs to the personal account, not an organization.

If Gradio is shown as paid on a new account, wait until the account is eligible.
Dedicated GPU hardware remains paid; select **ZeroGPU** specifically.

Official documentation:

- [ZeroGPU requirements and quotas](https://huggingface.co/docs/hub/main/spaces-zerogpu)
- [Hugging Face Spaces overview](https://huggingface.co/docs/hub/spaces-overview)

## 1. Create the Space

After the account becomes eligible:

1. Open <https://huggingface.co/new-space>.
2. Set the Space name to `myanmar-voxcpm2`.
3. Select **Gradio** as the SDK.
4. Use **Public** visibility for the easiest API access.
5. Create the Space.
6. Open **Settings → Hardware** and select **ZeroGPU**.

Use a separate Space repository. Do not upload the whole Chrome extension.

## 2. Add the Space `README.md`

In the Space, select **Files → Add file → Create new file**, name it
`README.md`, and paste:

```markdown
---
title: Myanmar VoxCPM2 TTS
emoji: 🔊
colorFrom: indigo
colorTo: purple
sdk: gradio
python_version: 3.10.13
app_file: app.py
pinned: false
preload_from_hub:
  - openbmb/VoxCPM2
---

# Myanmar VoxCPM2 TTS

Neutral Burmese text-to-speech powered by VoxCPM2.
```

The `preload_from_hub` entry downloads the model during the Space build.

## 3. Add `requirements.txt`

Create `requirements.txt` in the Space repository:

```text
numpy>=1.26,<3
soundfile>=0.12,<1
voxcpm
```

Gradio and the ZeroGPU `spaces` module are supplied by the Space runtime.

## 4. Add `app.py`

Create `app.py` in the Space repository:

```python
import os
import tempfile

import spaces
import gradio as gr
import numpy as np
import soundfile as sf
import torch
from voxcpm import VoxCPM


MODEL_ID = "openbmb/VoxCPM2"
DEFAULT_VOICE = (
    "A calm adult Burmese speaker with a neutral, warm, "
    "natural human voice and clear pronunciation"
)

# ZeroGPU emulates CUDA while the app starts. A real GPU is assigned while a
# function decorated with @spaces.GPU is running.
model = VoxCPM.from_pretrained(
    MODEL_ID,
    device="cuda",
    optimize=False,
    load_denoiser=False,
)


@spaces.GPU(duration=120)
def synthesize(text: str, voice_description: str):
    text = text.strip()
    if not text:
        raise gr.Error("Please enter some Myanmar text.")
    if len(text) > 500:
        raise gr.Error("Please limit each request to 500 characters.")

    description = voice_description.strip() or DEFAULT_VOICE
    # voxcpm's generate() has no seed argument; seed torch for a stable voice.
    torch.manual_seed(42)
    wav = model.generate(
        text=f"({description}){text}",
        cfg_value=2.0,
        inference_timesteps=10,
    )

    file_descriptor, output_path = tempfile.mkstemp(suffix=".wav")
    os.close(file_descriptor)
    sf.write(
        output_path,
        np.asarray(wav, dtype=np.float32).squeeze(),
        model.tts_model.sample_rate,
    )
    return output_path


demo = gr.Interface(
    fn=synthesize,
    inputs=[
        gr.Textbox(
            label="Myanmar text",
            lines=5,
            placeholder="မင်္ဂလာပါ။ နေကောင်းပါသလား။",
        ),
        gr.Textbox(
            label="Voice description",
            value=DEFAULT_VOICE,
        ),
    ],
    outputs=gr.Audio(
        label="Generated speech",
        type="filepath",
        format="wav",
    ),
    title="Myanmar VoxCPM2 Text to Speech",
    description="Generate neutral, natural Burmese speech.",
    api_name="tts",
    concurrency_limit=1,
)

demo.queue(default_concurrency_limit=1).launch()
```

ZeroGPU does not support `torch.compile`, which is why `optimize=False` is used.
The 120-second allocation allows slow first requests to finish. Shorter GPU
allocations get better queue priority, so reduce it later if requests finish
quickly.

## 5. Build and test

After committing the three files:

1. Open the Space's **App** tab.
2. Wait for the model and dependencies to build.
3. If the build fails, open **Logs** and inspect the first exception.
4. Confirm **Settings → Hardware → ZeroGPU** is still selected.
5. Use **Factory reboot** after correcting a dependency or configuration error.

Test with:

```text
မင်္ဂလာပါ။ ဒီအသံက သဘာဝကျတဲ့ မြန်မာစကားပြောအသံ ဖြစ်ပါတယ်။
```

The first request may wait while the Space wakes up and enters the GPU queue.
Free accounts currently have a small daily GPU allowance, so use short text
chunks while testing.

## 6. Test the API

The application URL will look like:

```text
https://YOUR_USERNAME-myanmar-voxcpm2.hf.space
```

Click **Use via API** at the bottom of the running Space. It displays the exact
endpoint and generated examples for the deployed Gradio version.

One way to test from Python is:

```bash
python -m pip install gradio_client
```

```python
from gradio_client import Client

client = Client("YOUR_USERNAME/myanmar-voxcpm2")
audio_file = client.predict(
    "မင်္ဂလာပါ။ နေကောင်းပါသလား။",
    "A calm adult Burmese speaker with a neutral natural voice",
    api_name="/tts",
)
print(audio_file)
```

Every Gradio Space exposes an API, but ZeroGPU requests use Gradio's queue and
return a generated audio-file location rather than a WAV response directly.

## 7. Connect this Chrome extension

The extension already includes the Gradio client in `offscreen.js`. To use
your own Space:

1. Set `VOXCPM2_SPACE` in `offscreen.js` to your Space URL, e.g.
   `https://YOUR_USERNAME-myanmar-voxcpm2.hf.space`.
2. Put the same host in `host_permissions` in `manifest.json`.
3. Reload the extension at `chrome://extensions`.
4. Create a **Read** token at <https://huggingface.co/settings/tokens> and
   paste it into the popup's **Hugging Face token** field.

Without a token, requests count as anonymous and quickly fail with
"You have exceeded your ZeroGPU runs limit". The extension sends the token as
`X-HF-Authorization: Bearer hf_...`, as `gradio_client` does; a plain
`Authorization` header is not used for ZeroGPU quota.

To check the API from a terminal:

```bash
SPACE=https://YOUR_USERNAME-myanmar-voxcpm2.hf.space/gradio_api/call/tts
EVENT_ID=$(curl -s -X POST "$SPACE" \
  -H 'Content-Type: application/json' \
  -H "X-HF-Authorization: Bearer $HF_TOKEN" \
  -d '{"data":["မင်္ဂလာပါ။","A calm adult Burmese speaker"]}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["event_id"])')
curl -s -N "$SPACE/$EVENT_ID" -H "X-HF-Authorization: Bearer $HF_TOKEN"
```

The stream ends with `event: complete` and the generated file's URL, or
`event: error` with the reason.

## Privacy and operational notes

- Text sent from the extension is processed on Hugging Face infrastructure.
- A public Space's source code is visible to everyone.
- Never commit Hugging Face access tokens or other secrets to the Space.
- Store sensitive values under **Settings → Variables and secrets**.
- Free Spaces can sleep when unused and are not suitable for guaranteed,
  low-latency production service.
