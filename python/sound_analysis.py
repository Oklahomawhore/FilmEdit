"""Target-independent sound evidence. Similarity is not a correctness probability."""
# Fixed vocabulary, shared across tasks; never derived from the requested sound or source title.
SOUND_DESCRIPTIONS = {
    "wind": "The sound of wind blowing and howling.",
    "rustle": "The sound of leaves rustling in the breeze.",
    "rain": "The sound of heavy rain falling.",
    "thunder": "The sound of a thunderstorm.",
    "water": "The sound of running water in a river.",
    "waves": "The sound of ocean waves crashing on the shore.",
    "fire": "The sound of a fire crackling.",
    "engine": "The sound of a car engine starting and revving.",
    "car_passing": "The sound of a car driving past.",
    "traffic": "The sound of busy road traffic.",
    "horn": "The sound of a car horn honking.",
    "brakes": "The sound of tires screeching and brakes squealing.",
    "aircraft": "The sound of an airplane flying overhead.",
    "music": "The sound of instrumental music playing.",
    "singing": "The sound of a person singing.",
    "speech": "The sound of a person speaking.",
    "crowd": "The sound of a crowd of people talking.",
    "laughter": "The sound of people laughing.",
    "applause": "The sound of people clapping and cheering.",
    "bird": "The sound of birds chirping and singing.",
    "dog": "The sound of a dog barking.",
    "footsteps": "The sound of footsteps walking.",
    "door": "The sound of a door opening and closing.",
    "keyboard": "The sound of typing on a keyboard.",
    "beep": "The sound of electronic beeps.",
    "sonar": "The sound of electronic sonar beeps.",
    "whoosh": "The sound of a short swooshing transition effect.",
    "impact": "The sound of a sudden impact and crash.",
    "machine": "The sound of a machine humming and rattling.",
    "noise": "The sound of static noise and hissing.",
    "silence": "Silence with no audible sound.",
}


def sound_windows(length, rate):
    """Partition all samples evenly into windows <=10s, without creating a tiny EOF tail."""
    if length < 1 or rate < 1:
        raise ValueError("Sound windows require positive sample count and rate")
    count = (length + rate * 10 - 1) // (rate * 10)
    return [(i * length // count, (i + 1) * length // count) for i in range(count)]


def analyze_sound(source, root):
    import numpy as np
    import soundfile as sf
    import torch
    from scipy.signal import resample_poly
    from transformers import AutoFeatureExtractor, AutoModelForAudioClassification, ClapModel, ClapProcessor

    torch.set_num_threads(1)
    torch.manual_seed(0)
    np.random.seed(0)
    torch.use_deterministic_algorithms(True)
    samples, rate = sf.read(source, dtype="float32")
    if rate != 48000 or samples.ndim != 1 or len(samples) == 0 or not np.isfinite(samples).all():
        raise RuntimeError("Sound analysis requires nonempty finite mono 48kHz PCM")
    extractor = AutoFeatureExtractor.from_pretrained(root / "audio", local_files_only=True)
    model = AutoModelForAudioClassification.from_pretrained(root / "audio", local_files_only=True).eval()
    processor = ClapProcessor.from_pretrained(root / "audio_text", local_files_only=True)
    clap = ClapModel.from_pretrained(root / "audio_text", local_files_only=True).eval()
    labels = list(SOUND_DESCRIPTIONS)
    windows = []
    with torch.inference_mode():
        text = clap.get_text_features(**processor(text=list(SOUND_DESCRIPTIONS.values()), return_tensors="pt", padding=True))
        text = torch.nn.functional.normalize(text, dim=-1)
        # Each deterministic window fits CLAP's 10s input. No random truncation of longer media.
        for start, end in sound_windows(len(samples), rate):
            chunk = samples[start:end]
            window = {
                "start": start / rate, "end": end / rate,
                "rmsDb": float(20 * np.log10(max(float(np.sqrt(np.mean(chunk ** 2))), 1e-8))),
                "peakDb": float(20 * np.log10(max(float(np.max(np.abs(chunk))), 1e-8))),
            }
            # AST needs at least one 25ms feature frame. Do not fabricate content by
            # extending/repeating a shorter observation; signal measurements remain valid.
            if len(chunk) < rate // 40:
                windows.append({**window, "contentStatus": "insufficient_duration", "tags": [], "similarities": []})
                continue
            scores = model(**extractor(resample_poly(chunk, 1, 3), sampling_rate=16000, return_tensors="pt")).logits.sigmoid()[0]
            features = clap.get_audio_features(**processor(audio=chunk, sampling_rate=rate, return_tensors="pt"))
            similarities = (torch.nn.functional.normalize(features, dim=-1) @ text.T)[0]
            if not torch.isfinite(similarities).all() or not torch.isfinite(scores).all():
                raise RuntimeError("Sound model returned nonfinite evidence")
            windows.append({
                **window, "contentStatus": "analyzed",
                "tags": [{"label": model.config.id2label[i], "score": float(scores[i])}
                         for i in scores.argsort(descending=True)[:8].tolist()],
                "similarities": [{"label": labels[i], "description": SOUND_DESCRIPTIONS[labels[i]],
                                  "cosine": max(-1.0, min(1.0, float(similarities[i])))}
                                 for i in similarities.argsort(descending=True)[:6].tolist()],
            })
    return {"duration": len(samples) / rate, "windows": windows}
