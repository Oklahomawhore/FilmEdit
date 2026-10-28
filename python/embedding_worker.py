"""CPU embeddings for cultural retrieval only; no NLI model or acceptance logic."""
import json
import os
import sys
from pathlib import Path

os.environ["TOKENIZERS_PARALLELISM"] = "false"
import torch
from transformers import AutoModel, AutoTokenizer

torch.manual_seed(0)
torch.set_num_threads(1)
torch.use_deterministic_algorithms(True)
root = Path(os.environ["FILMEDIT_MODEL_DIR"]) / "embedding"
tokenizer = AutoTokenizer.from_pretrained(root, local_files_only=True)
model = AutoModel.from_pretrained(root, local_files_only=True).eval()
cache = {}

def encode(text):
    if text not in cache:
        tokens = tokenizer(text, return_tensors="pt", truncation=True, max_length=1024)
        vector = model(**tokens).last_hidden_state[:, 0]
        cache[text] = torch.nn.functional.normalize(vector, p=2, dim=1)
    return cache[text]

with torch.inference_mode():
    result = [{"similarity": max(-1, min(1, (encode(p["premise"]) @ encode(p["hypothesis"]).T).item()))}
              for p in json.load(sys.stdin)["pairs"]]
print(json.dumps(result))
