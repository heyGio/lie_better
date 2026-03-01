"""
Local speech-emotion-recognition server using
speechbrain/emotion-recognition-wav2vec2-IEMOCAP via FastAPI.

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

try:
    from speechbrain.inference.interfaces import foreign_class
except Exception:  # pragma: no cover - compatibility fallback
    from speechbrain.pretrained.interfaces import foreign_class  # type: ignore

# ── Configuration ──────────────────────────────────────────────────────────────

MODEL_ID = os.getenv(
    "EMOTION_MODEL",
    "speechbrain/emotion-recognition-wav2vec2-IEMOCAP",
)
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
EXPECTED_SR = 16_000

HAS_FFMPEG = shutil.which("ffmpeg") is not None
if not HAS_FFMPEG:
    print("⚠️  [Emotion Service] ffmpeg not found — WebM/Opus decode may fail.")

# ── App + model ────────────────────────────────────────────────────────────────

app = FastAPI(title="Speech Emotion Recognition", version="2.0.0")

print(f"🎛️  [Emotion Service] Loading '{MODEL_ID}' on {DEVICE} ...")
_load_start = time.time()

classifier = foreign_class(
    source=MODEL_ID,
    pymodule_file="custom_interface.py",
    classname="CustomEncoderWav2vec2Classifier",
    run_opts={"device": DEVICE},
)

print(f"✅  [Emotion Service] Model ready in {time.time() - _load_start:.1f}s")

# ── Helpers ────────────────────────────────────────────────────────────────────


def _normalize_label(raw: str) -> str | None:
    value = raw.strip().lower()
    mapping = {
        "ang": "angry",
        "anger": "angry",
        "angry": "angry",
        "hap": "happy",
        "happiness": "happy",
        "happy": "happy",
        "joy": "happy",
        "neu": "neutral",
        "neutral": "neutral",
        "sad": "sad",
        "sadness": "sad",
        "fear": "fear",
        "fearful": "fear",
        "disgust": "disgust",
        "dis": "disgust",
        "sur": "surprise",
        "surprise": "surprise",
        "surprised": "surprise",
    }
    return mapping.get(value)


def _to_float(value: Any) -> float:
    if hasattr(value, "item"):
        try:
            return float(value.item())
        except Exception:
            pass
    if isinstance(value, (list, tuple)) and value:
        return _to_float(value[0])
    return float(value)


def _to_str(value: Any) -> str:
    if isinstance(value, (list, tuple)) and value:
        return _to_str(value[0])
    return str(value)


def _convert_to_wav_via_ffmpeg(raw_bytes: bytes) -> bytes:
    """Use ffmpeg to convert arbitrary audio bytes to 16 kHz mono WAV."""
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
                str(EXPECTED_SR),
                "-ac",
                "1",
                "-f",
                "wav",
                wav_path,
            ],
            capture_output=True,
            timeout=15,
            check=True,
        )
        with open(wav_path, "rb") as f:
            return f.read()
    finally:
        for path in (src_path, wav_path):
            try:
                os.unlink(path)
            except OSError:
                pass


def load_audio_as_wav_bytes(raw_bytes: bytes) -> bytes:
    """Normalize arbitrary input bytes into 16kHz mono WAV bytes."""
    try:
        audio, _ = librosa.load(io.BytesIO(raw_bytes), sr=EXPECTED_SR, mono=True)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as wav_file:
            wav_path = wav_file.name
        try:
            import soundfile as sf  # lazy import

            sf.write(wav_path, audio, EXPECTED_SR, subtype="PCM_16")
            with open(wav_path, "rb") as f:
                return f.read()
        finally:
            try:
                os.unlink(wav_path)
            except OSError:
                pass
    except Exception:
        pass

    if not HAS_FFMPEG:
        raise RuntimeError("Audio decode failed and ffmpeg is not installed.")

    return _convert_to_wav_via_ffmpeg(raw_bytes)


def classify_wav_bytes(wav_bytes: bytes) -> list[dict[str, float | str]]:
    """Return HF-like predictions list: [{label, score}, ...]."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as wav_file:
        wav_file.write(wav_bytes)
        wav_path = wav_file.name

    try:
        out_prob, score, _index, text_lab = classifier.classify_file(wav_path)
    finally:
        try:
            os.unlink(wav_path)
        except OSError:
            pass

    mapped_scores: dict[str, float] = {}

    # Best effort: decode full probability vector using SpeechBrain label encoder.
    try:
        probs_array = np.asarray(out_prob.detach().cpu()).squeeze()  # type: ignore[attr-defined]
        if probs_array.ndim == 0:
            probs_array = np.asarray([float(probs_array)])
        label_encoder = getattr(getattr(classifier, "hparams", None), "label_encoder", None)
        ind2lab = getattr(label_encoder, "ind2lab", None)

        labels: list[str] = []
        if isinstance(ind2lab, dict):
            labels = [str(ind2lab.get(i, i)) for i in range(int(probs_array.shape[0]))]
        elif isinstance(ind2lab, (list, tuple)):
            labels = [str(label) for label in ind2lab]

        if len(labels) != int(probs_array.shape[0]):
            labels = [str(i) for i in range(int(probs_array.shape[0]))]

        for raw_label, raw_score in zip(labels, probs_array.tolist()):
            normalized = _normalize_label(raw_label)
            if not normalized:
                continue
            mapped_scores[normalized] = max(mapped_scores.get(normalized, 0.0), float(raw_score))
    except Exception:
        # We'll still return top-1 from text label below.
        pass

    # Always keep top-1 from classifier output as fallback.
    try:
        top_label_raw = _to_str(text_lab)
        top_label = _normalize_label(top_label_raw)
        top_score = max(0.0, min(1.0, _to_float(score)))
        if top_label:
            mapped_scores[top_label] = max(mapped_scores.get(top_label, 0.0), top_score)
    except Exception:
        pass

    if not mapped_scores:
        raise RuntimeError("No valid emotion label returned by SpeechBrain classifier.")

    predictions = [
        {"label": label, "score": float(max(0.0, min(1.0, value)))}
        for label, value in sorted(mapped_scores.items(), key=lambda item: item[1], reverse=True)
    ]
    return predictions


# ── Routes ─────────────────────────────────────────────────────────────────────


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "model": MODEL_ID,
        "device": DEVICE,
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
        wav_bytes = load_audio_as_wav_bytes(raw)
        predictions = classify_wav_bytes(wav_bytes)
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
