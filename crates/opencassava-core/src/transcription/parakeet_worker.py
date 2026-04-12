import json
import os
import sys
import tempfile
import warnings

import numpy as np
import soundfile as sf

warnings.filterwarnings(
    "ignore",
    message="Couldn't find ffmpeg or avconv - defaulting to ffmpeg, but may not work",
    category=RuntimeWarning,
)


MODELS = {}
SPEAKER_ANCHORS = {}
SPEAKER_COUNTER = 0
TITANET_MODELS = {}
COSINE_THRESHOLD = 0.5
MIN_SPEAKER_ID_SAMPLES = 16_000  # 1.0 s at 16 kHz


def model_key(model_name: str, device: str) -> str:
    return f"{model_name}::{device}"


def resolve_device(payload, default="cpu"):
    device = (payload.get("resolved_device") or payload.get("device") or default or "cpu").strip()
    if not device or device.lower() == "auto":
        return "cpu"
    return device.lower()


def load_model(model_name: str, device: str):
    key = model_key(model_name, device)
    if key in MODELS:
        return MODELS[key]

    import nemo.collections.asr as nemo_asr

    model = nemo_asr.models.ASRModel.from_pretrained(model_name=model_name)
    model.eval()

    if device and device not in ("auto", "cpu"):
        try:
            import torch

            model = model.to(torch.device(device))
        except Exception:
            pass

    MODELS[key] = model
    return model


def cosine_similarity(a, b):
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


def load_titanet(device: str):
    key = device or "cpu"
    if key in TITANET_MODELS:
        return TITANET_MODELS[key]

    import nemo.collections.asr as nemo_asr

    model = nemo_asr.models.EncDecSpeakerLabelModel.from_pretrained(
        "nvidia/speakerverification_en_titanet_large"
    )
    model.eval()
    if device and device not in ("auto", "cpu"):
        try:
            import torch

            model = model.to(torch.device(device))
        except Exception:
            pass

    TITANET_MODELS[key] = model
    return model


def build_live_transcribe_kwargs(payload):
    return {
        "use_lhotse": bool(payload.get("use_lhotse", False)),
        "batch_size": int(payload.get("batch_size", 1)),
        "verbose": bool(payload.get("verbose", False)),
        "num_workers": 0,
    }


def transcribe_in_memory(model, samples, language, live_kwargs):
    if language:
        try:
            from nemo.collections.asr.parts.utils.transcribe_utils import TranscriptionConfig

            cfg = TranscriptionConfig(source_lang=language, target_lang=language, pnc="yes")
            for name, value in live_kwargs.items():
                if hasattr(cfg, name):
                    setattr(cfg, name, value)
            return model.transcribe(samples, override_config=cfg)
        except Exception:
            pass

    try:
        from nemo.collections.asr.parts.mixins.transcription import TranscribeConfig

        return model.transcribe(samples, override_config=TranscribeConfig(**live_kwargs))
    except Exception:
        return model.transcribe(samples, **live_kwargs)


def transcribe_with_tempfile(model, samples, language):
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
            tmp_path = temp_file.name
        sf.write(tmp_path, samples, 16000)

        if language:
            try:
                from nemo.collections.asr.parts.utils.transcribe_utils import TranscriptionConfig

                cfg = TranscriptionConfig(source_lang=language, target_lang=language, pnc="yes")
                return model.transcribe([tmp_path], override_config=cfg)
            except Exception:
                return model.transcribe([tmp_path])
        return model.transcribe([tmp_path])
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def handle_health():
    emit({"ok": True, "result": {"status": "ready"}})


def handle_ensure_model(payload):
    model_name = payload["model"]
    device = resolve_device(payload)
    load_model(model_name, device)
    if payload.get("diarization_enabled", False):
        try:
            load_titanet(device)
        except Exception as exc:
            print(f"[parakeet] Warning: TitaNet pre-load failed: {exc}", file=sys.stderr)
    emit({"ok": True, "result": {"model": model_name}})


def handle_clear_speakers():
    global SPEAKER_ANCHORS, SPEAKER_COUNTER
    SPEAKER_ANCHORS.clear()
    SPEAKER_COUNTER = 0
    emit({"ok": True, "result": {"cleared": True}})


def handle_speaker_id(payload):
    global SPEAKER_ANCHORS, SPEAKER_COUNTER

    samples = np.asarray(payload.get("samples", []), dtype=np.float32)
    if len(samples) < MIN_SPEAKER_ID_SAMPLES:
        emit({"ok": True, "result": {"speaker_id": None}})
        return

    device = resolve_device(payload)
    try:
        model = load_titanet(device)
    except Exception as exc:
        emit({"ok": False, "error": f"TitaNet load failed: {exc}"})
        return

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
            tmp_path = temp_file.name
        sf.write(tmp_path, samples, 16000)
        embedding = model.get_embedding(tmp_path)
        if hasattr(embedding, "cpu"):
            embedding = embedding.cpu().numpy()
        embedding = np.asarray(embedding, dtype=np.float32).flatten()
    except Exception as exc:
        emit({"ok": False, "error": f"Embedding extraction failed: {exc}"})
        return
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)

    best_id = None
    best_score = -1.0
    for sid, anchor in SPEAKER_ANCHORS.items():
        score = cosine_similarity(embedding, anchor)
        if score > best_score:
            best_score = score
            best_id = sid

    if best_id is not None and best_score >= COSINE_THRESHOLD:
        SPEAKER_ANCHORS[best_id] = 0.9 * SPEAKER_ANCHORS[best_id] + 0.1 * embedding
        emit({"ok": True, "result": {"speaker_id": best_id}})
    else:
        new_id = f"speaker_{SPEAKER_COUNTER}"
        SPEAKER_COUNTER += 1
        SPEAKER_ANCHORS[new_id] = embedding
        emit({"ok": True, "result": {"speaker_id": new_id}})


def handle_transcribe(payload):
    model_name = payload["model"]
    device = resolve_device(payload)
    language = payload.get("language", "")
    samples = np.asarray(payload.get("samples", []), dtype=np.float32).flatten()

    model = load_model(model_name, device)
    try:
        transcriptions = transcribe_in_memory(
            model,
            samples,
            language,
            build_live_transcribe_kwargs(payload),
        )
    except Exception as exc:
        print(
            f"[parakeet] Warning: in-memory transcription failed, falling back to temp file: {exc}",
            file=sys.stderr,
        )
        transcriptions = transcribe_with_tempfile(model, samples, language)

    raw = transcriptions[0] if transcriptions else ""
    text = raw.text if hasattr(raw, "text") else str(raw)
    emit({"ok": True, "result": {"text": text.strip()}})


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
            elif command == "clear_speakers":
                handle_clear_speakers()
            elif command == "speaker_id":
                handle_speaker_id(payload)
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
