#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


MODEL_MLX = "mlx-community/parakeet-tdt-0.6b-v3"
MODEL_HF = "nvidia/parakeet-tdt-0.6b-v3"


def fail(message: str, code: int = 1) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def normalize_with_ffmpeg(path: Path) -> Path:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return path
    out = Path(tempfile.gettempdir()) / f"voize-{os.getpid()}-16k.wav"
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(path),
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        str(out),
    ]
    try:
        subprocess.run(cmd, check=True)
        return out
    except Exception:
        return path


def clean_cli_output(raw: str) -> str:
    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    if not lines:
        return ""
    # parakeet-mlx currently prints the transcript plainly. If future versions
    # add progress lines, prefer the last substantial non-JSON line.
    for line in reversed(lines):
        if line.startswith("{") and line.endswith("}"):
            try:
                value = json.loads(line)
                text = value.get("text") or value.get("transcript")
                if text:
                    return str(text).strip()
            except Exception:
                pass
        if not line.lower().startswith(("loading", "model", "elapsed", "warning")):
            return line
    return lines[-1]


def transcribe_mlx(path: Path) -> str | None:
    exe = shutil.which("parakeet-mlx")
    if not exe:
        return None
    cmd = [exe, str(path), "--model", MODEL_MLX]
    try:
        proc = subprocess.run(cmd, text=True, capture_output=True, check=False)
    except Exception as exc:
        fail(f"Could not run parakeet-mlx: {exc}")
    if proc.returncode != 0:
        fail(proc.stderr.strip() or proc.stdout.strip() or "parakeet-mlx failed")
    return clean_cli_output(proc.stdout)


def transcribe_transformers(path: Path) -> str:
    try:
        from transformers import pipeline
    except Exception:
        fail(
            "Local Parakeet is not installed. Recommended on Apple Silicon: "
            "pip install -U parakeet-mlx. Fallback: pip install -U torch "
            "torchaudio transformers accelerate soundfile."
        )
    pipe = pipeline("automatic-speech-recognition", model=MODEL_HF)
    result = pipe(str(path))
    if isinstance(result, dict):
        return str(result.get("text") or "").strip()
    return str(result).strip()


def main() -> None:
    if len(sys.argv) != 2:
        fail("Usage: parakeet_transcribe.py audio.wav")
    audio = Path(sys.argv[1]).expanduser().resolve()
    if not audio.exists():
        fail(f"Audio file not found: {audio}")
    normalized = normalize_with_ffmpeg(audio)
    text = transcribe_mlx(normalized)
    engine = "parakeet-mlx"
    if text is None:
        text = transcribe_transformers(normalized)
        engine = "transformers"
    print(json.dumps({"text": text, "engine": engine}, ensure_ascii=False))


if __name__ == "__main__":
    main()
