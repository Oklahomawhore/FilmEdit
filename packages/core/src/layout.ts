import type { RenderIR } from './domain.js';
import { invariant } from './util.js';

export type Box = { x: number; y: number; width: number; height: number };
const anchors = {
  'top-left': [0, 0],
  top: [0.5, 0],
  'top-right': [1, 0],
  left: [0, 0.5],
  center: [0.5, 0.5],
  right: [1, 0.5],
  'bottom-left': [0, 1],
  bottom: [0.5, 1],
  'bottom-right': [1, 1],
} as const;
export function resolveBoxes(ir: RenderIR): Map<string, Box> {
  const boxes = new Map<string, Box>();
  const visiting = new Set<string>();
  const resolve = (id: string): Box => {
    const cached = boxes.get(id);
    if (cached) return cached;
    invariant(!visiting.has(id), 'IR_CYCLE', `Cyclic group ${id}`);
    visiting.add(id);
    const node = ir.nodes.find((n) => n.id === id);
    invariant(node, 'IR_NODE', `Missing node ${id}`);
    const parent = node.parentId
      ? resolve(node.parentId)
      : { x: 0, y: 0, width: ir.canvas.width, height: ir.canvas.height };
    let box: Box;
    if (node.placement.mode === 'rect') {
      const [x, y, w, h] = node.placement.rect;
      box = { x: x * parent.width, y: y * parent.height, width: w * parent.width, height: h * parent.height };
    } else {
      const [ax, ay] = anchors[node.placement.anchor];
      const [w, h] = node.placement.size;
      const [dx, dy] = node.placement.offset;
      box = {
        x: (ax * (1 - w) + dx) * parent.width,
        y: (ay * (1 - h) + dy) * parent.height,
        width: w * parent.width,
        height: h * parent.height,
      };
    }
    invariant(box.width >= 1 && box.height >= 1, 'IR_SIZE', `${id} is smaller than a pixel`);
    boxes.set(id, box);
    visiting.delete(id);
    return box;
  };
  for (const node of ir.nodes) resolve(node.id);
  return boxes;
}
export function evaluateFrame(node: RenderIR['nodes'][number], seconds: number) {
  const frames = node.keyframes;
  if (!frames.length) return { x: 0, y: 0, scale: 1, rotation: 0, opacity: node.opacity };
  const after = frames.findIndex((k) => k.time > seconds);
  const a = after === 0 ? frames[0]! : after === -1 ? frames.at(-1)! : frames[after - 1]!;
  const b = after <= 0 ? a : frames[after]!;
  const ratio = a === b ? 0 : Math.max(0, Math.min(1, (seconds - a.time) / (b.time - a.time)));
  const lerp = (key: 'x' | 'y' | 'scale' | 'rotation' | 'opacity') => a[key] + (b[key] - a[key]) * ratio;
  return {
    x: lerp('x'),
    y: lerp('y'),
    scale: lerp('scale'),
    rotation: lerp('rotation'),
    opacity: lerp('opacity') * node.opacity,
  };
}
