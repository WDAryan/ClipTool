import sys
import subprocess
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel


DEVANAGARI_MAP = str.maketrans({
    'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo',
    'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au',
    'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng',
    'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
    'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
    'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
    'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
    'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh',
    'ष': 'sh', 'स': 's', 'ह': 'h',
    'ा': 'a', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo',
    'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au',
    'ं': 'n', 'ँ': 'n', 'ः': 'h', '्': '', '़': '',
})


def romanize_hinglish(text: str) -> str:
    if not any('\u0900' <= character <= '\u097f' for character in text):
        return text
    return text.translate(DEVANAGARI_MAP).replace('  ', ' ').strip()


def format_timestamp(seconds: float) -> str:
    milliseconds = round(seconds * 1000)
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1_000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


def five_word_chunks(text: str) -> list[str]:
    words = text.split()
    if not words:
        return []
    return [" ".join(words[index:index + 5]) for index in range(0, len(words), 5)]


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

    subtitle_index = 1
    with output_path.open("w", encoding="utf-8") as subtitle_file:
        for segment in segments:
            text = segment.text.strip()
            if not text:
                continue
            if language == "hinglish":
                text = romanize_hinglish(text)
            chunks = five_word_chunks(text)
            duration = max(0.25, segment.end - segment.start)
            chunk_duration = duration / len(chunks)
            for chunk_index, chunk in enumerate(chunks):
                chunk_start = segment.start + chunk_index * chunk_duration
                chunk_end = chunk_start + chunk_duration
                subtitle_file.write(
                    f"{subtitle_index}\n{format_timestamp(chunk_start)} --> "
                    f"{format_timestamp(chunk_end)}\n{chunk}\n\n"
                )
                subtitle_index += 1


if __name__ == "__main__":
    main()
