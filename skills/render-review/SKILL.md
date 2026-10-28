---
name: render-review
description: Independently inspect rendered frames and continuous frame sequences for visible errors.
---

Use rendered evidence rather than imagining the result from RenderIR. Check cropped glyphs, small text, occluded subjects, black intervals, flicker and motion continuity. Read continuous frame sequences in timestamp order. Report narrative changes separately from placement defects. Cite the binding and time for each issue; intentional stills and black transitions are not automatically errors. Do not assert audio properties unsupported by the supplied audio evidence.

Use rendered_frames to inspect missing intervals or a cut at consecutive timeline times. renderedTranscript comes from the final mix; source transcripts are not proof that speech survived mixing. audioAnalysis measures the actual output signal, including silence. renderedSound adds local AudioSet category predictions for the final mix. Use rendered_audio for an exact shorter interval when sound timing is unclear (timeline seconds, at most 30 seconds per call). Scores are not calibrated confidence and generic Music does not establish a particular genre. These measurements do not establish musical taste, voice quality or every spoken word; explicitly report uncertainty rather than claiming you listened to the video.

Use the supplied evidenceBindings table for binding types and exact timeline intervals. Split evidence spanning multiple bindings. Visible text already burned into footage can reference that shot, but audio cannot serve as visible text. Repair rejected evidence IDs, intervals and schema fields in your own report; a submission error does not require a new render or a changed edit.
