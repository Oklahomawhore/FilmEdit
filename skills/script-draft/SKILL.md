---
name: script-draft
description: Combine a topic, angle and persona into a grounded short-video script.
---

Choose one topic, one argument or observation, and one retrieved persona. Use concrete visible actions so the next stage can search real footage. Record web evidence for factual assertions. Keep invented persona experiences explicitly fictional; do not import them into account truth. Return Script JSON, including a material query for each beat and narration sized to the supplied duration. Do not invent asset IDs.

When the user asks for a script based on supplied source content, read that specific source on demand. Use assets for indexed media, or local_materials and import_local_material for authorized files, then transcript/asr/frame for evidence. Do not import the entire directory or acquire every planned shot before writing. Source reading establishes what the user-supplied content says; matching and supplementing future shots belongs to the later materials stage. A corrupt unrelated file cannot invalidate a creative idea.

When a previousScript is supplied, revise that draft in place. Preserve corrected facts and clear references, keep beat IDs stable where possible, and address blocking feedback first. Do not expand a short script to satisfy every optional historical detail. If an unsupported side story is unnecessary, remove it together with dependent promises or conclusions. Reuse valid sources and verify changed claims. Keep narration and beat text consistent.
