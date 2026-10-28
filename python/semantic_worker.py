"""Frozen CPU embedding + NLI inference. No generative judge and no lexical fallback."""
import json
import os
import sys
from pathlib import Path

os.environ["TOKENIZERS_PARALLELISM"] = "false"
import torch
from transformers import AutoModel, AutoModelForSequenceClassification, AutoTokenizer


def main():
    torch.manual_seed(0)
    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)
    root = Path(os.environ["FILMEDIT_MODEL_DIR"])
    pairs = json.load(sys.stdin)["pairs"]
    embed_tokens = AutoTokenizer.from_pretrained(root / "embedding", local_files_only=True)
    embedding = AutoModel.from_pretrained(root / "embedding", local_files_only=True).eval()
    nli_tokens = AutoTokenizer.from_pretrained(root / "nli", local_files_only=True)
    nli = AutoModelForSequenceClassification.from_pretrained(root / "nli", local_files_only=True).eval()
    labels = {str(v).lower(): int(k) for k, v in nli.config.id2label.items()}
    # This pinned XNLI checkpoint documents contradiction=0, neutral=1, entailment=2.
    entailment = labels.get("entailment", 2)
    contradiction = labels.get("contradiction", 0)
    neutral = labels.get("neutral", 1)
    cache = {}

    def encode(text):
        if text not in cache:
            tokens = embed_tokens(text, return_tensors="pt", truncation=True, max_length=1024)
            vector = embedding(**tokens).last_hidden_state[:, 0]
            cache[text] = torch.nn.functional.normalize(vector, p=2, dim=1)
        return cache[text]

    result = []
    with torch.inference_mode():
        for pair in pairs:
            # Never let tokenizer truncation silently change an acceptance requirement.
            tokens = nli_tokens(pair["premise"], pair["hypothesis"], return_tensors="pt", truncation=False)
            if tokens.input_ids.shape[1] > 512:
                result.append({"similarity": 0, "entailment": 0, "contradiction": 0, "neutral": 1,
                               "inputTooLong": True, "inputTokens": int(tokens.input_ids.shape[1]),
                               "maxInputTokens": 512})
                continue
            similarity = (encode(pair["premise"]) @ encode(pair["hypothesis"]).T).item()
            probs = torch.softmax(nli(**tokens).logits, dim=-1)[0].tolist()
            result.append({"similarity": max(-1, min(1, similarity)), "entailment": probs[entailment], "contradiction": probs[contradiction], "neutral": probs[neutral]})
    print(json.dumps(result))


if __name__ == "__main__":
    main()
