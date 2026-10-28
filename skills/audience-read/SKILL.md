---
name: audience-read
description: Describe what an audience can infer from actual shots, sound transcripts and visible text.
---

For an editorial review, infer events and emotional progression only from the supplied execution timeline and actual media evidence. Distinguish what is visible from what is merely spoken. Cite binding IDs and exact timeline intervals. Do not infer a creator's intended meaning from metadata or technique names. Request more frames when an action is unclear. Unknown content stays unknown.

audioEvidence contains local sound category predictions, signal levels and actual ASR from the selected source intervals, mapped to the timeline. Use cut_audio with a bindingId and timeline start/end to examine a shorter source interval when needed. Source evidence does not prove audibility after mixing, and category scores are not calibrated confidence. A broad category does not prove a specific music genre or sound source; preserve uncertainty. Final mix inspection belongs to the rendered review.

For a script review, assess the planned visuals together with the narration. A video may communicate through pictures and rhythm; it is not required to explain every visual relationship in speech. Block contradictions or missing causal steps only when they remain after considering both channels. Do not invent a target interpretation or treat an internal title as visible text. The visuals are proposals at this stage: material availability and actual execution are checked later, and this review cannot certify an unseen video.

For structured timeline reviews, use evidenceBindings as the reference table. Evidence intervals use timeline seconds and stay within one binding; split observations spanning shots. Burned-in subtitles or signs use text evidence attached to the observed shot; narration uses audio evidence. Claims reference evidence IDs, not binding IDs. If submit_result rejects a report, repair the report against the unchanged timeline and resubmit it. A malformed report is not evidence that the edit needs changing.
