"""Time captions with the same Whisper + script-alignment method as PC Diagnostics.

Run on the speech host after takes are selected. Uses its cached turbo model.
No audio is sent to a cloud provider. A mismatched scene fails quality control.
"""
import argparse
import json
import sys
from pathlib import Path

import whisper

sys.path.insert(0, str(Path(__file__).parent / "toolkit"))
from captions import align, to_remotion, transcribe_whisper, write_caption_outputs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenes")
    args = parser.parse_args()
    directory = Path(args.scenes)
    model = whisper.load_model("turbo")
    report = []
    for audio in sorted(directory.glob("*.mp3")):
        script = audio.with_suffix(".txt").read_text().strip()
        heard = transcribe_whisper(model, audio, "en")
        words, ratio = align(script.split(), heard)
        result = {
            "scene": audio.stem,
            "matchRatio": round(ratio, 3),
            "transcript": " ".join(w["w"] for w in heard),
        }
        report.append(result)
        print(json.dumps(result), flush=True)
        if ratio < 0.85:
            raise RuntimeError(f"Speech/script mismatch for {audio.stem}; review or regenerate")
        write_caption_outputs(
            audio.with_suffix(".captions.json"), to_remotion(words),
            srt=True, vtt=True, max_words=7,
        )
    if not report:
        raise RuntimeError("No narration clips found")
    (directory / "alignment-report.json").write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
