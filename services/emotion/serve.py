"""
Local speech-emotion-recognition server using
3loi/SER-Odyssey-Baseline-WavLM-Categorical via FastAPI.

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
from transformers import AutoModelForAudioClassification

# ── Configuration ──────────────────────────────────────────────────────────────

MODEL_ID = os.getenv(
    "EMOTION_MODEL",
    "3loi/SER-Odyssey-Baseline-WavLM-Categorical",
)
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DEFAULT_EXPECTED_SR = 16_000
EMOTIONS = ("angry", "disgust", "fear", "happy", "neutral", "sad", "surprise")

HAS_FFMPEG = shutil.which("ffmpeg") is not None
if not HAS_FFMPEG:
    print("⚠️  [Emotion Service] ffmpeg not found — WebM/Opus decode may fail.")

# ── App + model ────────────────────────────────────────────────────────────────

app = FastAPI(title="Speech Emotion Recognition", version="2.1.0")

print(f"🎛️  [Emotion Service] Loading '{MODEL_ID}' on {DEVICE} ...")
_load_start = time.time()

classifier = AutoModelForAudioClassification.from_pretrained(
    MODEL_ID,
    trust_remote_code=True,
)
classifier.to(DEVICE)
classifier.eval()

MODEL_SR = int(getattr(classifier.config, "sampling_rate", DEFAULT_EXPECTED_SR) or DEFAULT_EXPECTED_SR)
MODEL_MEAN = float(getattr(classifier.config, "mean", 0.0) or 0.0)
MODEL_STD = float(getattr(classifier.config, "std", 1.0) or 1.0)

_id2label_raw = getattr(classifier.config, "id2label", {}) or {}
ID2LABEL: dict[int, str] = {}
if isinstance(_id2label_raw, dict):
    for key, value in _id2label_raw.items():
        try:
            ID2LABEL[int(key)] = str(value)
        except Exception:
            continue
elif isinstance(_id2label_raw, (list, tuple)):
    ID2LABEL = {index: str(value) for index, value in enumerate(_id2label_raw)}

print(
    "✅  [Emotion Service] Model ready",
    {
        "seconds": round(time.time() - _load_start, 1),
        "sample_rate": MODEL_SR,
        "labels": [ID2LABEL[index] for index in sorted(ID2LABEL.keys())] if ID2LABEL else "unknown",
    },
)

# ── Helpers ────────────────────────────────────────────────────────────────────


def _normalize_label(raw: str) -> str | None:
    value = " ".join(raw.strip().lower().replace("_", " ").replace("-", " ").split())
    mapping = {
        "angry": "angry",
        "anger": "angry",
        "ang": "angry",
        "happy": "happy",
        "happiness": "happy",
        "joy": "happy",
        "hap": "happy",
        "neutral": "neutral",
        "neu": "neutral",
        "sad": "sad",
        "sadness": "sad",
        "fear": "fear",
        "fearful": "fear",
        "disgust": "disgust",
        "disgusted": "disgust",
        "dis": "disgust",
        "surprise": "surprise",
        "surprised": "surprise",
        "sur": "surprise",
        # The Odyssey model includes "Contempt"; fold it into "disgust"
        # to remain compatible with the game's 7-label emotion set.
        "contempt": "disgust",
    }
    return mapping.get(value)


def _convert_to_wav_via_ffmpeg(raw_bytes: bytes, target_sr: int) -> bytes:
    """Use ffmpeg to convert arbitrary audio bytes to mono WAV at target_sr."""
    with tempfile.NamedTemporaryFile(suffix=".input", delete=False) as src:
        src.write(raw_bytes)
        src_path = src.name
    wav_path = src_path + ".wav"
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                src_path,
                "-ar",
                str(target_sr),
                "-ac",
                "1",
                "-f",
                "wav",
                wav_path,
            ],
            capture_output=True,
            timeout=20,
            check=True,
        )
        with open(wav_path, "rb") as wav_file:
            return wav_file.read()
    finally:
        for path in (src_path, wav_path):
            try:
                os.unlink(path)
            except OSError:
                pass


def load_audio_as_float32(raw_bytes: bytes, target_sr: int) -> np.ndarray:
    """Normalize arbitrary input bytes into mono float32 waveform."""
    try:
        audio, _ = librosa.load(io.BytesIO(raw_bytes), sr=target_sr, mono=True)
        normalized = np.asarray(audio, dtype=np.float32)
        if normalized.size > 0:
            return normalized
    except Exception:
        pass

    if not HAS_FFMPEG:
        raise RuntimeError("Audio decode failed and ffmpeg is not installed.")

    wav_bytes = _convert_to_wav_via_ffmpeg(raw_bytes, target_sr)
    audio, _ = librosa.load(io.BytesIO(wav_bytes), sr=target_sr, mono=True)
    normalized = np.asarray(audio, dtype=np.float32)
    if normalized.size == 0:
        raise RuntimeError("Decoded audio is empty.")
    return normalized


def _extract_logits(output: Any) -> torch.Tensor:
    if hasattr(output, "logits"):
        return output.logits  # type: ignore[return-value]
    if isinstance(output, (list, tuple)) and output:
        first = output[0]
        if isinstance(first, torch.Tensor):
            return first
    if isinstance(output, torch.Tensor):
        return output
    raise RuntimeError(f"Unexpected model output type: {type(output)}")


def classify_waveform(audio: np.ndarray) -> list[dict[str, float | str]]:
    """Return HF-like predictions list: [{label, score}, ...]."""
    if audio.ndim != 1 or audio.size == 0:
        raise RuntimeError("Audio waveform is empty or invalid.")

    std = MODEL_STD if np.isfinite(MODEL_STD) and MODEL_STD > 0 else 1.0
    normalized = (audio - MODEL_MEAN) / std

    waveform = torch.from_numpy(normalized).to(dtype=torch.float32, device=DEVICE).unsqueeze(0)
    mask = torch.ones((1, waveform.shape[1]), dtype=torch.long, device=DEVICE)

    with torch.no_grad():
        raw_output = classifier(waveform, mask)
    logits = _extract_logits(raw_output)
    if logits.ndim == 1:
        logits = logits.unsqueeze(0)
    probabilities = torch.softmax(logits, dim=-1).squeeze(0).detach().cpu().numpy()

    mapped_scores = {emotion: 0.0 for emotion in EMOTIONS}
    for index, raw_score in enumerate(probabilities.tolist()):
        raw_label = ID2LABEL.get(index, str(index))
        normalized_label = _normalize_label(raw_label)
        if not normalized_label:
            continue
        clamped = float(max(0.0, min(1.0, raw_score)))
        mapped_scores[normalized_label] = max(mapped_scores[normalized_label], clamped)

    highest = max(mapped_scores.values()) if mapped_scores else 0.0
    if highest <= 0:
        raise RuntimeError("No valid emotion label returned by classifier.")

    predictions = [
        {"label": label, "score": score}
        for label, score in sorted(mapped_scores.items(), key=lambda item: item[1], reverse=True)
        if score > 0
    ]
    return predictions


# ── Routes ─────────────────────────────────────────────────────────────────────


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "model": MODEL_ID,
        "device": DEVICE,
        "sampleRate": MODEL_SR,
    }


@app.post("/classify")
async def classify(file: UploadFile = File(...)) -> JSONResponse:
    """
    Accept an audio file (wav, webm, ogg, mp3 …) and return emotion scores.
    Response mirrors HF inference shape: [[{label, score}, ...]]
    so existing TypeScript clients can parse it with minimal changes.
    """
    raw = await file.read()
    if not raw:
        return JSONResponse({"error": "Empty audio file."}, status_code=400)

    try:
        audio = load_audio_as_float32(raw, MODEL_SR)
        predictions = classify_waveform(audio)
    except Exception as exc:
        return JSONResponse({"error": f"Could not classify audio: {exc}"}, status_code=422)

    return JSONResponse(content=[predictions])


# ── Entrypoint ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.getenv("EMOTION_PORT", "5050")))
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    print(f"🚀  [Emotion Service] Starting on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
