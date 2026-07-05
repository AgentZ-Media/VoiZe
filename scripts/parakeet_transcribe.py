#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional


MODEL_MLX = "mlx-community/parakeet-tdt-0.6b-v3"
MODEL_HF = "nvidia/parakeet-tdt-0.6b-v3"


def expanded_path() -> str:
    home = Path.home()
    candidates = [
        home / ".local" / "bin",
        home / ".cargo" / "bin",
        Path("/opt/homebrew/bin"),
        Path("/usr/local/bin"),
        Path("/usr/bin"),
        Path("/bin"),
        Path("/usr/sbin"),
        Path("/sbin"),
    ]
    current = os.environ.get("PATH", "")
    parts = [str(path) for path in candidates if path.exists()]
    parts.extend([part for part in current.split(os.pathsep) if part])
    return os.pathsep.join(dict.fromkeys(parts))


os.environ["PATH"] = expanded_path()


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


def transcribe_mlx(path: Path) -> Optional[str]:
    exe = shutil.which("parakeet-mlx", path=os.environ["PATH"])
    if not exe:
        return None
    with tempfile.TemporaryDirectory(prefix="voize-parakeet-") as tmp:
        out_dir = Path(tmp)
        cmd = [
            exe,
            str(path),
            "--model",
            MODEL_MLX,
            "--output-format",
            "json",
            "--output-dir",
            str(out_dir),
            "--output-template",
            "result",
            "--chunk-duration",
            "0",
        ]
        try:
            proc = subprocess.run(cmd, text=True, capture_output=True, check=False)
        except Exception as exc:
            fail(f"parakeet-mlx konnte nicht gestartet werden: {exc}")
        if proc.returncode != 0:
            fail(proc.stderr.strip() or proc.stdout.strip() or "parakeet-mlx ist fehlgeschlagen")
        result = out_dir / "result.json"
        if result.exists():
            value = json.loads(result.read_text(encoding="utf-8"))
            return str(value.get("text") or "").strip()
        return clean_cli_output(proc.stdout)


def prepare_mlx() -> None:
    exe = shutil.which("parakeet-mlx", path=os.environ["PATH"])
    if not exe:
        fail("parakeet-mlx ist nicht installiert. Installiere es mit: python3 -m pip install -U parakeet-mlx")
    import math
    import wave

    with tempfile.TemporaryDirectory(prefix="voize-prepare-") as tmp:
        wav_path = Path(tmp) / "prepare.wav"
        sample_rate = 16000
        with wave.open(str(wav_path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(sample_rate)
            frames = bytearray()
            for i in range(sample_rate):
                sample = int(math.sin(2 * math.pi * 440 * i / sample_rate) * 900)
                frames.extend(sample.to_bytes(2, "little", signed=True))
            wav.writeframes(bytes(frames))
        _ = transcribe_mlx(wav_path)
    print(json.dumps({"ready": True, "engine": "parakeet-mlx"}, ensure_ascii=False))


def transcribe_transformers(path: Path) -> str:
    try:
        from transformers import pipeline
    except Exception:
        fail(
            "Lokales Parakeet ist nicht installiert. Empfohlen auf Apple Silicon: "
            "python3 -m pip install -U parakeet-mlx. Ausweichoption: python3 -m pip install -U torch "
            "torchaudio transformers accelerate soundfile."
        )
    pipe = pipeline("automatic-speech-recognition", model=MODEL_HF)
    result = pipe(str(path))
    if isinstance(result, dict):
        return str(result.get("text") or "").strip()
    return str(result).strip()


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--prepare":
        prepare_mlx()
        return
    if len(sys.argv) != 2:
        fail("Aufruf: parakeet_transcribe.py audio.wav")
    audio = Path(sys.argv[1]).expanduser().resolve()
    if not audio.exists():
        fail(f"Audiodatei nicht gefunden: {audio}")
    normalized = normalize_with_ffmpeg(audio)
    text = transcribe_mlx(normalized)
    engine = "parakeet-mlx"
    if text is None:
        text = transcribe_transformers(normalized)
        engine = "transformers"
    print(json.dumps({"text": text, "engine": engine}, ensure_ascii=False))


if __name__ == "__main__":
    main()
