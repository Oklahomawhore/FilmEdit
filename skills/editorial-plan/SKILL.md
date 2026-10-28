---
name: editorial-plan
description: Build an engine-independent EditorialIR from verified material and a script.
---

Express meaning through shot order, duration, sound and text. Use the actual TTS duration. Cuts have zero overlap; transitions have an overlap exactly equal to their duration. J/L cuts are audio timing choices. Beat cuts must use analyzed beat timestamps. Keep coordinates and styling out of EditorialIR. Reference only cataloged assets and supported technique versions. Revision feedback is evidence to investigate, not an instruction to repeat scorer keywords.

shots.track is an integer. Track 0 supplies continuous picture for the whole duration; tracks 1+ contain independent pictures that can overlap it for split screen, picture-in-picture, keyed foregrounds or visual comparisons. Each track may only overlap its own adjacent clips during declared transitions. Transitions never cross tracks. Put the different source clips in EditorialIR first; the layout stage places their nodes. A duplicate of one source does not satisfy a request to show two different subjects.

Place cut technique references on the incoming shot. jump_cut needs discontinuous time from the same source; beat_cut needs a real analyzed beat in the active music, transformed by its sourceStart/start/speed. j_cut/l_cut refer to the shot whose synchronized source sound enters earlier or exits later. speed requires speed != 1. These are validated before review; naming a technique without its timing is rejected. Match-cut meaning and montage relationships are also judged by the independent audience.

When revisionScope is present, change only its [scope.start, scope.end) interval. Preserve total duration and every unaffected binding ID, source position, sound envelope, text and transition. Split crossing clips when needed, retaining the original ID on the unchanged part and adjusting sourceStart to preserve its source frames. Do not regenerate the rest of the timeline. The program checks this restriction before accepting your edit.

If observed material cannot support the script or audience feedback reveals a material mismatch, submit {kind:"material_request",needIds:[existing requirement IDs],reason:"specific missing/wrong evidence"}. The host returns to material matching and preserves the creative brief and script. Do not endlessly rearrange the same unsuitable clips, fabricate a match, or weaken fixed requirements. Evidence formatting mistakes are repaired by the reviewer and do not justify requesting new footage.
