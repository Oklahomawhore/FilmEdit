---
name: layout-compose
description: Position approved editorial elements on a fixed canvas using RenderIR.
---

Bind nodes to the supplied editorial hash and element IDs. Use normalized rectangles or anchor/size/offset placements. Base x/y/width/height are fractions in [0,1]; a full-frame element is [0,0,1,1], never [0,0,canvas.width,canvas.height]. Canvas dimensions and fontSize are pixels. Keyframe x/y are pixel translations; scale is a multiplier. Use keyframes for deliberate motion or zoom; group transforms inherit through the parent. A frame is an animation keyframe, not a separate layout for every video frame. Include every required visual and text binding. Keep text within safe areas and allow realistic Chinese wrapping. Do not edit source ranges, text content, audio or shot order to fix layout.

Multiple editorial tracks describe simultaneous pictures. Lay out every active binding so its subject is visible: use adjacent rectangles for split screen, an inset over a full base for picture-in-picture, or an alpha foreground over a background for keying. Their screen positions and z order belong here; track numbers themselves do not decide composition. Do not cover one required subject with another full-frame node.

When revisionScope is present, preserve the approved layout and animation outside its time interval. Retain unaffected binding appearances, parent transforms, z order and cropping. If an editorial clip was split, rebase its binding-relative keyframes so the unchanged part looks identical at the same timeline time. Do not reapply a new theme to the whole video.
