import json
import re
import subprocess
import sys
from pathlib import Path


def format_time(seconds: float) -> str:
    minutes, remaining = divmod(max(0, round(seconds)), 60)
    return f"{minutes:02}:{remaining:02}"


def media_duration(input_path: Path) -> float:
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(input_path)],
        capture_output=True,
        text=True,
    )
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr)
    if not match:
        return 60.0
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def scene_times(input_path: Path) -> list[float]:
    result = subprocess.run(
        [
            "ffmpeg", "-v", "info", "-i", str(input_path),
            "-vf", "select='gt(scene,0.18)',showinfo",
            "-an", "-f", "null", "-",
        ],
        capture_output=True,
        text=True,
    )
    values = [
        float(match)
        for match in re.findall(r"pts_time:([0-9.]+)", result.stderr)
    ]
    return sorted(set(values))


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python tools/analyze_montage.py INPUT_VIDEO")

    input_path = Path(sys.argv[1])
    duration = media_duration(input_path)
    segment_duration = 5.0
    scenes = scene_times(input_path)

    candidates: list[float] = [
        max(0.0, min(duration - segment_duration, duration * 0.08)),
        max(0.0, min(duration - segment_duration, duration * 0.35)),
        max(0.0, min(duration - segment_duration, duration * 0.62)),
        max(0.0, min(duration - segment_duration, duration * 0.86)),
    ]
    for scene in scenes:
        start = max(0.0, min(duration - segment_duration, scene - segment_duration / 2))
        if all(abs(start - existing) >= 12 for existing in candidates):
            candidates.insert(1, start)
        if len(candidates) >= 7:
            break

    unique: list[float] = []
    for candidate in sorted(candidates):
        if all(abs(candidate - existing) >= 8 for existing in unique):
            unique.append(candidate)
        if len(unique) == 5:
            break

    if len(unique) < 3:
        unique = [duration * 0.1, duration * 0.5, duration * 0.82]

    output = [{
        "id": 1,
        "start": round(unique[0], 2),
        "duration": round(segment_duration * len(unique[:5]), 2),
        "title": "AI visual montage",
        "time": "Multiple moments",
        "score": 96,
        "reason": "Scene changes + visual variety",
        "parts": [
            {"start": round(start, 2), "duration": segment_duration}
            for start in unique[:5]
        ],
    }]
    print(json.dumps(output))


if __name__ == "__main__":
    main()
