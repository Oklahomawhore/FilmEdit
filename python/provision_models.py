"""Explicit model installation. Lock immutable Hub revisions and retain the lock on reruns."""
import argparse
import json
import time
from pathlib import Path
from huggingface_hub import HfApi, snapshot_download

parser = argparse.ArgumentParser()
parser.add_argument("directory", type=Path)
parser.add_argument("--whisper", action="store_true")
parser.add_argument("--audio", action="store_true", help="Install local AudioSet and CLAP sound evidence models")
args = parser.parse_args()
args.directory.mkdir(parents=True, exist_ok=True)
manifest_path = args.directory / "manifest.json"
manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
lock_path = args.directory / "download-lock.json"
lock = json.loads(lock_path.read_text()) if lock_path.exists() else {}


def save_json(destination, value):
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(destination)


models = {"embedding": "BAAI/bge-m3"}
if args.whisper:
    models["whisper"] = "Systran/faster-whisper-small"
if args.audio:
    models["audio"] = "MIT/ast-finetuned-audioset-10-10-0.4593"
    models["audio_text"] = "laion/clap-htsat-unfused"
for key, repo in models.items():
    revision = manifest.get(key, {}).get("revision") or lock.get(key, {}).get("revision")
    info = HfApi().model_info(repo, revision=revision)
    revision = info.sha
    lock[key] = {"repository": repo, "revision": revision}
    # Pin even interrupted downloads; manifest only advertises completed models.
    save_json(lock_path, lock)
    target = args.directory / key
    files = {entry.rfilename for entry in info.siblings}
    weights = ["model.bin"] if key == "whisper" else (
        ["model.safetensors"] if "model.safetensors" in files else ["pytorch_model.bin"]
    )
    required = ["config.json", *weights]
    if not all(name in files for name in required):
        raise RuntimeError(f"Unsupported model files in {repo}@{revision}")
    selected = [name for name in [
        *required, "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json",
        "sentencepiece.bpe.model", "added_tokens.json", "vocabulary.txt", "preprocessor_config.json", "merges.txt", "vocab.json",
    ] if name in files]
    print(f"Downloading {key}: {repo}@{revision} ({len(selected)} files)", flush=True)
    for attempt in range(1, 4):
        try:
            snapshot_download(repo, revision=revision, local_dir=target, allow_patterns=selected, max_workers=4)
            break
        except Exception as error:
            status = getattr(getattr(error, "response", None), "status_code", None)
            if attempt == 3 or status in (400, 401, 403, 404):
                raise
            print(f"{key}: download interrupted ({type(error).__name__}); resuming attempt {attempt + 1}/3", flush=True)
            time.sleep(2 * attempt)
    manifest[key] = {"repository": repo, "revision": revision}
    save_json(manifest_path, manifest)
print(f"Set FILMEDIT_MODEL_DIR={args.directory.resolve()}")
