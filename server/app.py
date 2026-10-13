"""Small localhost-only HTTP wrapper around the VoxCPM2 model."""

from __future__ import annotations

import asyncio
import io
import os
from contextlib import asynccontextmanager

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from voxcpm import VoxCPM


MODEL_ID = os.getenv("VOXCPM_MODEL_ID", "openbmb/VoxCPM2")
DEVICE = os.getenv("VOXCPM_DEVICE", "auto")
OPTIMIZE = os.getenv("VOXCPM_OPTIMIZE", "0").lower() in {"1", "true", "yes"}
SEED = int(os.getenv("VOXCPM_SEED", "42"))
REFERENCE_WAV = os.getenv("VOXCPM_REFERENCE_WAV")
PROMPT_TEXT = os.getenv("VOXCPM_PROMPT_TEXT")
VOICE_DESCRIPTION = os.getenv(
    "VOXCPM_VOICE_DESCRIPTION",
    "A calm adult Burmese speaker with a neutral, warm, natural human voice",
)


class SynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Loading once at startup avoids downloading/reloading 2B parameters for
    # every browser request. The first launch downloads the model weights.
    app.state.model = await asyncio.to_thread(
        VoxCPM.from_pretrained,
        MODEL_ID,
        load_denoiser=False,
        device=DEVICE,
        optimize=OPTIMIZE,
    )
    app.state.generate_lock = asyncio.Lock()
    yield


app = FastAPI(title="VoxCPM2 TTS", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://[a-p]{32}$",
    allow_methods=["GET", "POST"],
    allow_headers=["content-type"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "model": MODEL_ID, "device": DEVICE}


@app.post("/tts", response_class=Response)
async def synthesize(payload: SynthesisRequest, request: Request) -> Response:
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text cannot be blank")

    kwargs: dict[str, object] = {
        "text": text,
        "cfg_value": 2.0,
        "inference_timesteps": 10,
        "seed": SEED,
    }
    if REFERENCE_WAV:
        if not os.path.isfile(REFERENCE_WAV):
            raise HTTPException(
                status_code=500,
                detail="VOXCPM_REFERENCE_WAV does not point to a file",
            )
        kwargs["reference_wav_path"] = REFERENCE_WAV
        if PROMPT_TEXT:
            # Supplying the exact transcript gives the most faithful cloning.
            kwargs["prompt_wav_path"] = REFERENCE_WAV
            kwargs["prompt_text"] = PROMPT_TEXT
    else:
        kwargs["text"] = f"({VOICE_DESCRIPTION}){text}"

    try:
        async with request.app.state.generate_lock:
            wav = await asyncio.to_thread(request.app.state.model.generate, **kwargs)
        audio = np.asarray(wav, dtype=np.float32).squeeze()
        output = io.BytesIO()
        sf.write(
            output,
            audio,
            request.app.state.model.tts_model.sample_rate,
            format="WAV",
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Synthesis failed: {exc}") from exc

    return Response(
        content=output.getvalue(),
        media_type="audio/wav",
        headers={"Cache-Control": "no-store"},
    )
