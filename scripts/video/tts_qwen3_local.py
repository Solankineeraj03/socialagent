"""Generate narration takes with Qwen3-TTS on a local CUDA GPU (no cloud endpoint).

Mirrors the toolkit's docker/runpod-qwen3-tts handler (CustomVoice model, bf16, sdpa,
generate_custom_voice with a built-in speaker + instruct). Writes, per take:
    <out>/t<k>/<scene-id>.wav and <scene-id>.txt
so tools/pick_takes.py can choose the best take per scene.

Usage (on the GPU host, inside the pc-video-tts venv, with CUDA_VISIBLE_DEVICES set):
    python tts_qwen3_local.py narration.json takes --takes 3
"""

import argparse
import json
import time
from pathlib import Path

import soundfile as sf
import torch
from huggingface_hub import snapshot_download
from qwen_tts import Qwen3TTSModel


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("narration")
    ap.add_argument("out")
    ap.add_argument("--takes", type=int, default=3)
    ap.add_argument("--only", nargs="*", help="regenerate just these scene ids")
    a = ap.parse_args()

    cfg = json.loads(Path(a.narration).read_text())
    voice = cfg["voice"]
    # Load from the pinned local snapshot: a hub id makes the tokenizer loader call the hub
    # API even when the files are cached, which fails offline.
    path = snapshot_download(voice["model"], revision=voice["revision"], local_files_only=True)
    model = Qwen3TTSModel.from_pretrained(
        path, device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa"
    )
    log = []
    for k in range(1, a.takes + 1):
        d = Path(a.out) / f"t{k}"
        d.mkdir(parents=True, exist_ok=True)
        for i, scene in enumerate(cfg["scenes"]):
            if a.only and scene["id"] not in a.only:
                continue
            torch.manual_seed(1000 * k + i)  # reproducible, but different per take
            t0 = time.time()
            wavs, sr = model.generate_custom_voice(
                text=scene["text"],
                language=voice["language"],
                speaker=voice["speaker"],
                instruct=voice["instruct"],
            )
            wav = wavs[0] if isinstance(wavs, list) else wavs
            sf.write(d / f"{scene['id']}.wav", wav, sr)
            (d / f"{scene['id']}.txt").write_text(scene["text"] + "\n")
            secs = len(wav) / sr
            log.append({"take": k, "scene": scene["id"], "seconds": round(secs, 2),
                        "gen_seconds": round(time.time() - t0, 2)})
            print(json.dumps(log[-1]), flush=True)
    (Path(a.out) / ("generation-log" + ("-" + "-".join(a.only) if a.only else "") + ".json")).write_text(json.dumps(
        {"voice": voice, "torch": torch.__version__, "gpu": torch.cuda.get_device_name(0),
         "takes": log}, indent=1))


if __name__ == "__main__":
    main()
