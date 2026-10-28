"""Install one free, local Piper voice; synthesis never downloads models."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path
from huggingface_hub import HfApi, hf_hub_download

parser = argparse.ArgumentParser()
parser.add_argument("directory", type=Path, help="FILMEDIT_MODEL_DIR")
args = parser.parse_args()
target = args.directory.resolve() / "tts"
target.mkdir(parents=True, exist_ok=True)
repository = "rhasspy/piper-voices"
prefix = "zh/zh_CN/huayan/medium"
voice = "zh_CN-huayan-medium"
lock_path = target / "download-lock.json"
lock = json.loads(lock_path.read_text()) if lock_path.exists() else {}
revision = lock.get("revision") or HfApi().model_info(repository).sha
lock_path.write_text(json.dumps({"repository": repository, "revision": revision}, indent=2) + "\n")
files = {}
for name in [f"{voice}.onnx", f"{voice}.onnx.json", "MODEL_CARD"]:
    print(f"Downloading {name}@{revision}", flush=True)
    source = hf_hub_download(repository, f"{prefix}/{name}", revision=revision)
    destination = target / name
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    shutil.copyfile(source, temporary)
    temporary.replace(destination)
    files[name] = hashlib.sha256(destination.read_bytes()).hexdigest()
manifest = {"repository": repository, "revision": revision, "voice": voice, "files": files}
temporary = target / "manifest.tmp"
temporary.write_text(json.dumps(manifest, indent=2) + "\n")
temporary.replace(target / "manifest.json")
print(f"Local TTS ready: {target / (voice + '.onnx')}")
