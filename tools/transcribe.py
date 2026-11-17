import sys
import subprocess
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel
from indic_transliteration import sanscript


def format_timestamp(seconds: float) -> str:
    milliseconds = round(seconds * 1000)
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1_000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("Usage: python tools/transcribe.py INPUT_VIDEO OUTPUT_SRT LANGUAGE")

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    language = sys.argv[3]
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
    whisper_language = "hi" if language == "hinglish" else "en"
    segments, _ = model.transcribe(audio, language=whisper_language, vad_filter=True)

    with output_path.open("w", encoding="utf-8") as subtitle_file:
        for index, segment in enumerate(segments, start=1):
            text = segment.text.strip()
            if not text:
                continue
            if language == "hinglish":
                text = sanscript.transliterate(text, sanscript.DEVANAGARI, sanscript.ITRANS)
                text = text.replace("A", "a").replace("I", "i").replace("U", "u")
            subtitle_file.write(
                f"{index}\n{format_timestamp(segment.start)} --> "
                f"{format_timestamp(segment.end)}\n{text}\n\n"
            )


if __name__ == "__main__":
    main()
