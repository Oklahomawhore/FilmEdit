"""Install the rembg-pinned U2Net weights explicitly; inference never downloads them."""
import argparse
import hashlib
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("directory", type=Path, help="FILMEDIT_MODEL_DIR")
args = parser.parse_args()
target = args.directory.resolve() / "matte"
target.mkdir(parents=True, exist_ok=True)
os.environ["U2NET_HOME"] = str(target)
os.environ.pop("MODEL_CHECKSUM_DISABLED", None)

from rembg.sessions.u2net import U2netSession

# rembg 2.0.67 pins the release URL and verifies its known checksum before returning.
model = Path(U2netSession.download_models())
manifest = {
    "model": "u2net",
    "provider": "rembg",
    "sha256": hashlib.sha256(model.read_bytes()).hexdigest(),
}
temporary = target / "manifest.tmp"
temporary.write_text(json.dumps(manifest, indent=2) + "\n")
temporary.replace(target / "manifest.json")
print(f"Local segmentation model ready: {model}")
