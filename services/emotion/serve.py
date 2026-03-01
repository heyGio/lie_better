"""
Local speech-emotion-recognition server using
r-f/wav2vec-english-speech-emotion-recognition
on NVIDIA GPU via the Hugging Face transformers pipeline.

Start:
    python serve.py                     # default: 0.0.0.0:5050
    python serve.py --port 6060         # custom port
    EMOTION_PORT=6060 python serve.py   # via env var
"""

from __future__ import annotations

import argparse
import io
import os
import shutil
import subprocess
import tempfile
import time
from typing import Any

import librosa
import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
from transformers import pipeline  # type: ignore[import-untyped]

# ── Configuration ──────────────────────────────────────────────────────────────

MODEL_ID = os.getenv(
    "EMOTION_MODEL",
    "r-f/wav2vec-english-speech-emotion-recognition",
)
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

HAS_FFMPEG = shutil.which("ffmpeg") is not None
if not HAS_FFMPEG:
    print("⚠️   ffmpeg not found – WebM/Opus audio will NOT be decodable.")

# ── App + model ────────────────────────────────────────────────────────────────

app = FastAPI(title="Speech Emotion Recognition", version="1.0.0")

print(f"🔧  Loading model '{MODEL_ID}' on {DEVICE} …")
_start = time.time()

classifier = pipeline(
    task="audio-classification",
    model=MODEL_ID,
    device=0 if DEVICE == "cuda" else -1,
    torch_dtype=torch.float16 if DEVICE == "cuda" else torch.float32,
)

print(f"✅  Model loaded in {time.time() - _start:.1f}s  (device={DEVICE})")

# ── Helpers ────────────────────────────────────────────────────────────────────

EXPECTED_SR = 16_000  # wav2vec pipelines expect 16 kHz mono


def _convert_to_wav_via_ffmpeg(raw_bytes: bytes) -> bytes:
    """Use ffmpeg to convert arbitrary audio bytes to 16 kHz mono WAV."""
    with tempfile.NamedTemporaryFile(suffix=".input", delete=False) as src:
        src.write(raw_bytes)
        src_path = src.name
    wav_path = src_path + ".wav"
    try:
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", src_path,
                "-ar", str(EXPECTED_SR),
                "-ac", "1",
                "-f", "wav",
                wav_path,
            ],
            capture_output=True,
            timeout=15,
            check=True,
        )
        with open(wav_path, "rb") as f:
            return f.read()
    finally:
        for p in (src_path, wav_path):
            try:
                os.unlink(p)
            except OSError:
                pass


def load_audio_array(raw_bytes: bytes) -> np.ndarray:
    """Load arbitrary audio bytes into a 16 kHz mono float32 numpy array.

    Tries librosa (soundfile) directly first.  If that fails (e.g. for
    WebM/Opus which libsndfile cannot decode), falls back to converting
    via ffmpeg → WAV.
    """
    try:
        audio, _ = librosa.load(io.BytesIO(raw_bytes), sr=EXPECTED_SR, mono=True)
        return audio  # type: ignore[return-value]
    except Exception:
        pass  # fall through to ffmpeg conversion

    if not HAS_FFMPEG:
        raise RuntimeError(
            "Audio format not supported by libsndfile and ffmpeg is not installed."
        )

    wav_bytes = _convert_to_wav_via_ffmpeg(raw_bytes)
    audio, _ = librosa.load(io.BytesIO(wav_bytes), sr=EXPECTED_SR, mono=True)
    return audio  # type: ignore[return-value]


# ── Routes ─────────────────────────────────────────────────────────────────────


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "model": MODEL_ID, "device": DEVICE}


@app.post("/classify")
async def classify(file: UploadFile = File(...)) -> JSONResponse:
    """
    Accept an audio file (wav, webm, ogg, mp3 …) and return emotion scores.
    Response shape mirrors what the HF Inference API returns so the existing
    TypeScript consumer works without changes.
    """
    raw = await file.read()
    if not raw:
        return JSONResponse({"error": "Empty audio file."}, status_code=400)

    try:
        audio_array = load_audio_array(raw)
    except Exception as exc:
        return JSONResponse(
            {"error": f"Could not decode audio: {exc}"},
            status_code=422,
        )

    # The pipeline expects either a file path or a dict with {"raw": ..., "sampling_rate": ...}
    results: list[dict[str, Any]] = classifier(
        {"raw": audio_array, "sampling_rate": EXPECTED_SR},
        top_k=None,  # return ALL labels
    )

    # Return in the same [[{label, score}, …]] shape that the HF API uses
    return JSONResponse(content=[results])


# ── Entrypoint ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("EMOTION_PORT", "5050")),
    )
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
