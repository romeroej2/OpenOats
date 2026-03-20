import json
import os
import sys
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel


MODELS = {}


def normalize_device(device: str) -> str:
    device = (device or "auto").strip().lower()
    if device == "auto":
        return "cpu"
    return device


def model_key(model_name: str, device: str, compute_type: str) -> str:
    return f"{model_name}::{device}::{compute_type}"


def load_model(model_name: str, device: str, compute_type: str, download_root: str):
    key = model_key(model_name, device, compute_type)
    if key in MODELS:
        return MODELS[key]

    model = WhisperModel(
        model_name,
        device=normalize_device(device),
        compute_type=compute_type,
        download_root=download_root,
    )
    MODELS[key] = model
    return model


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def handle_health():
    emit({"ok": True, "result": {"status": "ready"}})


def handle_ensure_model(payload):
    model_name = payload["model"]
    device = payload.get("device", "auto")
    compute_type = payload.get("compute_type", "default")
    download_root = payload["download_root"]
    load_model(model_name, device, compute_type, download_root)
    emit({"ok": True, "result": {"model": model_name}})


def handle_transcribe(payload):
    model_name = payload["model"]
    device = payload.get("device", "auto")
    compute_type = payload.get("compute_type", "default")
    download_root = payload["download_root"]
    language = (payload.get("language") or "").strip() or None
    samples = np.asarray(payload.get("samples", []), dtype=np.float32)

    model = load_model(model_name, device, compute_type, download_root)
    segments, _info = model.transcribe(
        samples,
        language=language,
        beam_size=1,
        vad_filter=False,
        condition_on_previous_text=False,
        word_timestamps=False,
    )
    text = "".join(segment.text for segment in segments).strip()
    emit({"ok": True, "result": {"text": text}})


def main():
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            payload = json.loads(line)
            command = payload.get("command")
            if command == "health":
                handle_health()
            elif command == "ensure_model":
                handle_ensure_model(payload)
            elif command == "transcribe":
                handle_transcribe(payload)
            elif command == "shutdown":
                emit({"ok": True, "result": {"shutdown": True}})
                return
            else:
                emit({"ok": False, "error": f"Unknown command: {command}"})
        except Exception as exc:
            emit({"ok": False, "error": str(exc)})


if __name__ == "__main__":
    main()
