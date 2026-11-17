import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel


def format_time(seconds: float) -> str:
    minutes, remaining = divmod(max(0, round(seconds)), 60)
    return f"{minutes:02}:{remaining:02}"


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python tools/analyze_highlights.py INPUT_VIDEO")

    input_path = Path(sys.argv[1])
    model = WhisperModel("tiny", device="cpu", compute_type="int8")
    audio_bytes = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-i", str(input_path), "-f", "s16le",
            "-ac", "1", "-ar", "16000", "pipe:1",
        ],
        check=True,
        capture_output=True,
    ).stdout
    audio = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    segments, _ = model.transcribe(audio, language="en", vad_filter=True)
    transcript = [
        {"start": segment.start, "end": segment.end, "text": segment.text.strip()}
        for segment in segments
        if segment.text.strip()
    ]
    if not transcript:
        print("[]")
        return

    window_size = 30
    rms = np.sqrt(np.convolve(audio * audio, np.ones(16000) / 16000, mode="valid"))
    candidates: list[dict[str, object]] = []
    for segment in transcript:
        start = max(0, segment["start"] - 8)
        end = min(len(audio) / 16000, start + window_size)
        words = sum(len(item["text"].split()) for item in transcript if item["start"] < end and item["end"] > start)
        audio_start = int(start * 16000)
        audio_end = min(len(rms), int(end * 16000))
        energy = float(np.mean(rms[audio_start:audio_end])) if audio_end > audio_start else 0
        title = " ".join(str(segment["text"]).split()[:7]).strip(".,!?")
        candidates.append({
            "start": round(start, 2),
            "duration": round(end - start, 2),
            "title": title or "Interesting moment",
            "words": words,
            "energy": energy,
        })

    max_words = max(item["words"] for item in candidates) or 1
    max_energy = max(item["energy"] for item in candidates) or 1
    ranked = sorted(
        candidates,
        key=lambda item: (item["words"] / max_words) * 0.65 + (item["energy"] / max_energy) * 0.35,
        reverse=True,
    )
    selected: list[dict[str, object]] = []
    for item in ranked:
        if any(abs(float(item["start"]) - float(existing["start"])) < 20 for existing in selected):
            continue
        score = round(60 + ((item["words"] / max_words) * 0.65 + (item["energy"] / max_energy) * 0.35) * 39)
        selected.append({
            "start": item["start"],
            "duration": item["duration"],
            "title": item["title"],
            "score": score,
            "reason": "Transcript density + audio energy",
        })
        if len(selected) == 3:
            break

    for index, item in enumerate(sorted(selected, key=lambda value: float(value["start"])), start=1):
        item["id"] = index
        item["time"] = f"{format_time(float(item['start']))} - {format_time(float(item['start']) + float(item['duration']))}"
    print(json.dumps(selected))


if __name__ == "__main__":
    main()
