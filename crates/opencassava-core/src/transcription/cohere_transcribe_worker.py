import json
import os
import sys
import traceback

import numpy as np
import torch
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor


processor_instance = None
model_instance = None
bundle_key = None


def log(message):
    sys.stderr.write(f"[worker] {message}\n")
    sys.stderr.flush()


def normalize_model_load_error(exc, model_name):
    message = str(exc)
    lowered = message.lower()
    if "gated repo" in lowered or "not in the authorized list" in lowered or "403 client error" in lowered:
        return (
            f"Your Hugging Face token is valid, but this account does not have access to the gated model "
            f"{model_name}. Visit https://huggingface.co/{model_name} and request or confirm access, then try setup again."
        )
    return message


def send_ok(result=None):
    sys.stdout.write(json.dumps({"ok": True, "result": result or {}}) + "\n")
    sys.stdout.flush()


def send_err(message):
    sys.stdout.write(json.dumps({"ok": False, "error": str(message)}) + "\n")
    sys.stdout.flush()


def normalize_device(device):
    device = (device or "auto").lower()
    if device == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested for Cohere Transcribe but no CUDA device is available.")
        return "cuda", torch.float16
    if device == "cpu":
        return "cpu", torch.float32
    if torch.cuda.is_available():
        return "cuda", torch.float16
    return "cpu", torch.float32


def load_model_bundle(model_name, requested_device, download_root, hugging_face_token):
    global processor_instance, model_instance, bundle_key

    resolved_device, dtype = normalize_device(requested_device)
    key = (model_name, resolved_device, download_root)
    if processor_instance is not None and model_instance is not None and bundle_key == key:
        log(f"reusing model bundle for model={model_name} device={resolved_device}")
        return processor_instance, model_instance

    if hugging_face_token:
        os.environ["HF_TOKEN"] = hugging_face_token
        os.environ["HUGGING_FACE_HUB_TOKEN"] = hugging_face_token

    log(
        f"loading model bundle model={model_name} device={resolved_device} "
        f"download_root={download_root}"
    )
    try:
        processor_instance = AutoProcessor.from_pretrained(
            model_name,
            trust_remote_code=True,
            token=hugging_face_token,
            cache_dir=download_root,
        )
        model_instance = AutoModelForSpeechSeq2Seq.from_pretrained(
            model_name,
            trust_remote_code=True,
            token=hugging_face_token,
            cache_dir=download_root,
            dtype=dtype,
        )
        target_device = "cuda:0" if resolved_device == "cuda" else "cpu"
        model_instance = model_instance.to(target_device)
        model_instance.eval()
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(normalize_model_load_error(exc, model_name)) from exc
    bundle_key = key
    log("model bundle loaded successfully")
    return processor_instance, model_instance


def handle_health(_payload):
    log("health check requested")
    import transformers  # noqa: F401

    log("health check passed")
    send_ok({"status": "ok"})


def handle_ensure_model(payload):
    model_name = payload["model"]
    requested_device = payload.get("device", "auto")
    download_root = payload["download_root"]
    hugging_face_token = payload.get("hugging_face_token")
    log(
        f"ensure_model requested model={model_name} device={requested_device} "
        f"download_root={download_root}"
    )
    if not hugging_face_token:
        raise RuntimeError(
            "A Hugging Face access token is required to download Cohere Transcribe locally."
        )
    os.makedirs(download_root, exist_ok=True)
    load_model_bundle(model_name, requested_device, download_root, hugging_face_token)
    log("ensure_model completed")
    send_ok({"ready": True})


def handle_transcribe(payload):
    model_name = payload["model"]
    requested_device = payload.get("device", "auto")
    download_root = payload["download_root"]
    hugging_face_token = payload.get("hugging_face_token")
    language = payload.get("language")
    samples = payload["samples"]
    log(
        f"transcribe requested model={model_name} device={requested_device} "
        f"language={language or 'none'} samples={len(samples)}"
    )

    if not hugging_face_token:
        raise RuntimeError(
            "A Hugging Face access token is required to load Cohere Transcribe locally."
        )

    if not language:
        raise RuntimeError(
            "Cohere Transcribe requires an explicit language code. Auto detection is not supported."
        )
    processor, model = load_model_bundle(
        model_name, requested_device, download_root, hugging_face_token
    )
    clipped = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    log(
        f"running transcription for in-memory audio with {len(clipped)} samples language={language}"
    )
    texts = model.transcribe(
        processor=processor,
        audio_arrays=[clipped],
        sample_rates=[16000],
        language=language,
    )
    text = texts[0] if texts else ""
    log(f"transcription completed with {len(text.strip())} chars")
    send_ok({"text": text.strip()})


def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
            command = payload.get("command")
            log(f"received command={command}")
            if command == "health":
                handle_health(payload)
            elif command == "ensure_model":
                handle_ensure_model(payload)
            elif command == "transcribe":
                handle_transcribe(payload)
            elif command == "shutdown":
                send_ok({"shutdown": True})
                return
            else:
                raise RuntimeError(f"Unknown command: {command}")
        except Exception as exc:  # noqa: BLE001
            log(f"command failed: {exc}")
            log(traceback.format_exc().strip())
            send_err(str(exc))


if __name__ == "__main__":
    main()
