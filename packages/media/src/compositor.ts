import type { EditorialIR } from '../../core/src/domain.js';
import { validateRender } from '../../core/src/ir.js';
import { resolveBoxes } from '../../core/src/layout.js';
import { validateTechniques } from '../../core/src/techniques.js';
import { invariant } from '../../core/src/util.js';

const escape = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const scriptJson = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');
export function compileHtml(editorial: EditorialIR, input: unknown, prepared: Map<string, string>) {
  const ir = validateRender(input, editorial);
  validateTechniques(editorial, ir);
  const boxes = resolveBoxes(ir);
  const nodeHtml = (parent?: string): string =>
    ir.nodes
      .filter((n) => n.parentId === parent)
      .map((node) => {
        const box = boxes.get(node.id)!;
        let style = `position:absolute;left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px;z-index:${node.z};opacity:${node.opacity};overflow:hidden;transform-origin:center;`;
        if (node.mask !== 'none') style += `border-radius:${node.mask === 'circle' ? '50%' : '24px'};`;
        if (node.kind === 'group') return `<div id="${node.id}" style="${style}">${nodeHtml(node.id)}</div>`;
        const binding = [...editorial.shots, ...editorial.text].find((s) => s.id === node.bindingId)!;
        const timing = `data-start="${binding.start}" data-duration="${binding.duration}" data-track-index="${node.z}"`;
        if (node.kind === 'text') {
          invariant('text' in binding, 'IR_BINDING', 'Text node requires text binding');
          const font = node.style!;
          invariant(font, 'IR_TEXT_STYLE', `Text node ${node.id} needs a style`);
          style += `font-family:${font.fontFamily};font-size:${font.fontSize}px;line-height:${font.lineHeight};color:${font.color};text-align:${font.align};white-space:pre-wrap;overflow-wrap:anywhere;box-sizing:border-box;padding:8px;${font.background ? `background:${font.background};` : ''}`;
          return `<div class="clip measured-text" id="${node.id}" ${timing} style="${style}">${escape(binding.text)}</div>`;
        }
        const file = prepared.get(binding.id);
        invariant(file, 'RENDER_MEDIA', `No prepared media for ${binding.id}`);
        let mediaStyle = `width:100%;height:100%;object-fit:${node.fit};`;
        if (node.crop) {
          const [x, y, w, h] = node.crop;
          mediaStyle = `position:absolute;width:${100 / w}%;height:${100 / h}%;left:${(-x / w) * 100}%;top:${(-y / h) * 100}%;object-fit:fill;`;
        }
        const image = /\.(png|jpe?g|webp)$/i.test(file);
        const media = image
          ? `<img id="media_${node.id}" src="${escape(file)}" ${timing} style="${mediaStyle}"/>`
          : `<video id="media_${node.id}" src="${escape(file)}" ${timing} data-media-start="0" muted playsinline style="${mediaStyle}"></video>`;
        return `<div class="clip" id="${node.id}" ${timing} style="${style}">${media}</div>`;
      })
      .join('\n');
  const animations = ir.nodes.map((n) => ({
    id: n.id,
    opacity: n.opacity,
    frames: n.keyframes,
    offset:
      ir.animationTimebase === 'binding'
        ? ([...editorial.shots, ...editorial.text].find((b) => b.id === n.bindingId)?.start ?? 0)
        : 0,
  }));
  const transitions = editorial.transitions
    .filter((t) => t.kind !== 'cut')
    .map((t) => ({
      ...t,
      start: editorial.shots.find((s) => s.id === t.to)!.start,
      nodes: ir.nodes.filter((n) => n.bindingId === t.to).map((n) => n.id),
    }));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=${ir.canvas.width}, height=${ir.canvas.height}"><script src="./gsap.min.js"></script><style>html,body{margin:0;padding:0;background:${ir.canvas.background}}#root{position:relative;isolation:isolate;width:${ir.canvas.width}px;height:${ir.canvas.height}px;overflow:hidden}</style></head><body><div id="root" data-composition-id="main" data-start="0" data-duration="${editorial.duration}" data-width="${ir.canvas.width}" data-height="${ir.canvas.height}">${nodeHtml()}</div><script>
  (async()=>{await document.fonts.ready;window.__layoutIssues=[];
  for(const el of document.querySelectorAll('.measured-text')){if(el.scrollHeight>el.clientHeight+1||el.scrollWidth>el.clientWidth+1)window.__layoutIssues.push({id:el.id,issue:'text_overflow'});}
  const tl=gsap.timeline({paused:true});tl.to({}, {duration:${editorial.duration}},0);
  for(const node of ${scriptJson(animations)}){for(let i=0;i<node.frames.length;i++){const f=node.frames[i],v={x:f.x,y:f.y,scale:f.scale,rotation:f.rotation,opacity:f.opacity*node.opacity};if(i===0)tl.set('#'+node.id,v,node.offset);else{const prev=node.frames[i-1];tl.to('#'+node.id,{...v,duration:f.time-prev.time,ease:'none'},node.offset+prev.time);}}}
  for(const t of ${scriptJson(transitions)}){for(const id of t.nodes){if(t.kind==='fade')tl.fromTo('#'+id,{opacity:0},{opacity:1,duration:t.duration,ease:'none'},t.start);if(t.kind==='wipe')tl.fromTo('#'+id,{clipPath:'inset(0 100% 0 0)'},{clipPath:'inset(0 0% 0 0)',duration:t.duration,ease:'none'},t.start);if(t.kind==='slide')tl.fromTo('#'+id,{x:${ir.canvas.width}},{x:0,duration:t.duration,ease:'none'},t.start);}}
  window.__timelines={main:tl};})();</script></body></html>`;
}
