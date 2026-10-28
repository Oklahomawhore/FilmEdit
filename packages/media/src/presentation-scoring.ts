import type { EditorialIR, RenderIR } from '../../core/src/domain.js';
import type { Predicate } from '../../core/src/acceptance.js';
import { evaluateFrame, resolveBoxes, type Box } from '../../core/src/layout.js';
import { hash } from '../../core/src/util.js';

type Measurement = Extract<Predicate, { kind: 'layout_mode' | 'playback_rate' }>;
type Result = { status: 'supported' | 'contradicted' | 'unknown'; diagnostic: string };
type Panel = Box & { rate: number };
const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width - 0.01 &&
  b.x < a.x + a.width - 0.01 &&
  a.y < b.y + b.height - 0.01 &&
  b.y < a.y + a.height - 0.01;
const contains = (a: Box, b: Box) =>
  b.x >= a.x - 0.01 &&
  b.y >= a.y - 0.01 &&
  b.x + b.width <= a.x + a.width + 0.01 &&
  b.y + b.height <= a.y + a.height + 0.01;

/** Inspect the same frame times, group transforms and binding offsets used by the compositor.
 * Unsupported masks/transitions/occlusion remain unknown, never silently treated as ordinary panels.
 * These measurements establish renderer parameters, not the meaning or quality of rendered pixels. */
export function measurePresentation(
  check: Measurement,
  editorial: EditorialIR,
  render?: RenderIR,
  renderedFps = render?.canvas.fps,
): Result {
  const unknown = (diagnostic: string): Result => ({ status: 'unknown', diagnostic });
  if (!render) return unknown('RenderIR is required for panel and playback measurements');
  if (!renderedFps || !Number.isFinite(renderedFps) || renderedFps <= 0)
    return unknown('A valid output frame rate is required');
  if (render.editorialHash !== hash(editorial)) return unknown('RenderIR is bound to a different edit');
  const boxes = resolveBoxes(render);
  const range = check.interval ?? { start: 0, end: editorial.duration };
  const fps = renderedFps;
  // Compositor samples n/fps. A fractional cut starts on the next output frame.
  const first = Math.ceil(range.start * fps - 1e-6);
  const last = Math.ceil(range.end * fps - 1e-6);
  if (last <= first) return unknown('Interval contains no rendered frame samples');
  const root = { x: 0, y: 0, width: render.canvas.width, height: render.canvas.height, scale: 1, opacity: 1 };
  for (let frame = first; frame < last; frame++) {
    const time = frame / fps;
    if (
      editorial.transitions.some(
        (t) =>
          t.kind !== 'cut' &&
          editorial.shots.some((s) => s.id === t.to && time >= s.start && time < s.start + t.duration),
      )
    )
      return unknown(`Transition geometry is not measurable at frame ${frame}`);
    const resolved = new Map<string, typeof root | null>();
    const visiting = new Set<string>();
    const resolve = (id: string): typeof root | null => {
      if (resolved.has(id)) return resolved.get(id)!;
      if (visiting.has(id)) return null;
      visiting.add(id);
      const node = render.nodes.find((n) => n.id === id);
      if (!node) return null;
      const parent = node.parentId ? resolve(node.parentId) : root;
      if (!parent) return null;
      const binding = [...editorial.shots, ...editorial.text].find((b) => b.id === node.bindingId);
      const localTime = time - (render.animationTimebase === 'binding' ? (binding?.start ?? 0) : 0);
      const transform = evaluateFrame(node, localTime);
      const box = boxes.get(id)!;
      const value = {
        x: parent.x + (box.x + (box.width * (1 - transform.scale)) / 2 + transform.x) * parent.scale,
        y: parent.y + (box.y + (box.height * (1 - transform.scale)) / 2 + transform.y) * parent.scale,
        width: box.width * transform.scale * parent.scale,
        height: box.height * transform.scale * parent.scale,
        scale: parent.scale * transform.scale,
        opacity: parent.opacity * transform.opacity,
      };
      const valid = node.mask === 'none' && Math.abs(transform.rotation) < 1e-9 && contains(parent, value);
      resolved.set(id, valid ? value : null);
      visiting.delete(id);
      return valid ? value : null;
    };
    const panels: Panel[] = [];
    const overlays: Box[] = [];
    for (const node of render.nodes.filter((n) => n.kind !== 'group')) {
      const binding = [...editorial.shots, ...editorial.text].find((b) => b.id === node.bindingId);
      if (!binding) return unknown(`Unbound node ${node.id}`);
      if (time < binding.start || time >= binding.start + binding.duration) continue;
      const box = resolve(node.id);
      if (!box) return unknown(`Masked, rotated or clipped node ${node.id} at frame ${frame}`);
      if (box.opacity === 0) continue;
      if (node.kind === 'text') {
        overlays.push(box);
        continue;
      }
      if (box.opacity !== 1) return unknown(`Translucent media at frame ${frame}`);
      const shot = editorial.shots.find((s) => s.id === node.bindingId)!;
      if (shot.techniques.some((t) => ['chromakey', 'portrait_matte', 'reverse'].includes(t.id)))
        return unknown(`Non-rectangular or reversed media at frame ${frame}`);
      panels.push({ ...box, rate: shot.techniques.some((t) => t.id === 'freeze') ? 0 : shot.speed });
    }
    if (
      panels.some((a, i) => panels.slice(i + 1).some((b) => intersects(a, b))) ||
      overlays.some((a) => panels.some((b) => intersects(a, b)))
    )
      return unknown(`Overlapping or obscured media at frame ${frame}`);
    const horizontal =
      panels.length === 2 &&
      (panels[0]!.x + panels[0]!.width <= panels[1]!.x + 0.01 ||
        panels[1]!.x + panels[1]!.width <= panels[0]!.x + 0.01) &&
      Math.min(...panels.map((p) => p.y + p.height)) > Math.max(...panels.map((p) => p.y));
    const vertical =
      panels.length === 2 &&
      (panels[0]!.y + panels[0]!.height <= panels[1]!.y + 0.01 ||
        panels[1]!.y + panels[1]!.height <= panels[0]!.y + 0.01) &&
      Math.min(...panels.map((p) => p.x + p.width)) > Math.max(...panels.map((p) => p.x));
    let ok: boolean;
    if (check.kind === 'layout_mode') {
      ok =
        check.mode === 'single' ? panels.length === 1 : check.mode === 'left_right' ? horizontal : vertical;
    } else {
      let selected = panels;
      if (check.region !== 'all') {
        const leftRight = check.region === 'left' || check.region === 'right';
        if (!(leftRight ? horizontal : vertical))
          return {
            status: 'contradicted',
            diagnostic: `No corresponding split arrangement at frame ${frame}`,
          };
        selected = [...panels].sort((a, b) => (leftRight ? a.x - b.x : a.y - b.y));
        selected = [selected[check.region === 'left' || check.region === 'top' ? 0 : 1]!];
      }
      const precision = Math.max(1, String(check.rate).split('.')[1]?.length ?? 0);
      ok =
        selected.length > 0 &&
        selected.every((p) =>
          check.approximate
            ? Number(p.rate.toFixed(precision)) === check.rate
            : Math.abs(p.rate - check.rate) < 1e-6,
        );
    }
    if (!ok)
      return {
        status: 'contradicted',
        diagnostic: `Parameter requirement fails at frame ${frame} (${time}s)`,
      };
  }
  return {
    status: 'supported',
    diagnostic: `Checked rendered frames ${first} through ${last - 1}; perceived motion and content require independent observation`,
  };
}
