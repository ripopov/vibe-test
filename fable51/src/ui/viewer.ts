import type { SGraph, SNode } from '../model/graph';
import { allNodes } from '../model/graph';
import type { Placed } from '../layout/layout';
import { renderGraph, type RenderOptions } from '../render/schematic';

export interface ViewerCallbacks {
  onSelectNode(node: SNode | null): void;
  onSelectNet(nets: string[]): void;
  onOpenNode(node: SNode): void; // double click / double tap => descend
  onContextMenu(node: SNode | null, nets: string[] | null, x: number, y: number): void;
  onHover(tip: string | null): void;
}

/**
 * How view changes made by gestures (drag, pinch, wheel) reach the screen.
 *  - direct: the viewport <g> transform is updated every animation frame (crisp, repaints the whole SVG)
 *  - composited: the <svg> element gets a CSS transform (GPU composited, no repaint); the real transform is
 *    committed when the gesture pauses or ends. Used for large graphs where a repaint takes longer than a frame.
 *  - auto: pick by element count after each render
 */
export type GestureMode = 'auto' | 'direct' | 'composited';

/** graphs with more rendered SVG elements than this use the composited gesture path */
const COMPOSITED_THRESHOLD = 5000;
const MIN_SCALE = 0.02;
const MAX_SCALE = 8;
const TAP_SLOP = 8; // px of movement that still counts as a tap
const DOUBLE_TAP_MS = 350;
const LONG_PRESS_MS = 500;
const PAUSE_COMMIT_MS = 180;
const WHEEL_COMMIT_MS = 120;

interface Ptr {
  x: number;
  y: number;
  type: string;
}

export class Viewer {
  private viewport: SVGGElement;
  /** committed view transform (viewport <g> attribute) */
  private tx = 0;
  private ty = 0;
  private scale = 1;
  /** pending view transform (target of the current gesture) */
  private ptx = 0;
  private pty = 0;
  private pscale = 1;
  private frame = 0;
  private commitTimer = 0;
  private graph: SGraph | null = null;
  private bounds = { width: 0, height: 0 };
  private tooltip: HTMLElement;
  private hlNets = new Set<string>();
  private selectedId: string | null = null;

  // input state
  private pointers = new Map<number, Ptr>();
  private dragMoved = false;
  private downX = 0;
  private downY = 0;
  private lastX = 0;
  private lastY = 0;
  private pinch: { dist: number; mx: number; my: number; tx: number; ty: number; scale: number } | null = null;
  private longPress = 0;
  private suppressClick = false;
  private lastTap = { t: 0, x: 0, y: 0 };
  private lastPointerType = 'mouse';
  /** element under the last primary pointerdown: with pointer capture, click/dblclick target the container */
  private downTarget: Element | null = null;
  private gestureMode: GestureMode = 'auto';
  private composited = false;
  private gesturing = false;
  /** number of rendered SVG elements (decides the gesture path in auto mode) */
  elementCount = 0;
  private insets = { top: 0, right: 0, bottom: 0, left: 0 };

  constructor(private container: HTMLElement, private svg: SVGSVGElement, private cb: ViewerCallbacks) {
    this.viewport = svg.querySelector('#viewport') as SVGGElement;
    this.tooltip = container.querySelector('#tooltip') as HTMLElement;
    this.bind();
  }

  render(graph: SGraph, placed: Placed, bounds: { width: number; height: number }, opts: RenderOptions, keepView = false) {
    this.graph = graph;
    this.bounds = bounds;
    this.hideTip();
    this.cancelGesture();
    renderGraph(this.viewport, graph, placed, opts);
    this.netIndex = null;
    this.litElements = [];
    this.selectedEl = null;
    this.elementCount = this.viewport.getElementsByTagName('*').length;
    this.updateMode();
    if (!keepView) this.fit();
    else this.applyTransform();
    this.applyHighlight();
  }

  get nodeCount(): number {
    let c = 0;
    if (this.graph) for (const _ of allNodes(this.graph)) c++;
    return c;
  }

  setGestureMode(mode: GestureMode) {
    this.gestureMode = mode;
    this.updateMode();
  }

  /** true when gestures currently use the composited (CSS transform) path */
  isComposited(): boolean {
    return this.composited;
  }

  private updateMode() {
    this.composited = this.gestureMode === 'composited' || (this.gestureMode === 'auto' && this.elementCount > COMPOSITED_THRESHOLD);
    // a permanent compositing layer means commits repaint into the layer instead of re-creating it
    this.svg.style.willChange = this.composited ? 'transform' : '';
  }

  /** screen areas (overlays) that fitted content should stay clear of */
  setFitInsets(insets: { top: number; right: number; bottom: number; left: number }) {
    this.insets = insets;
  }

  fit() {
    const { top, right, bottom, left } = this.insets;
    const w = this.container.clientWidth - left - right;
    const h = this.container.clientHeight - top - bottom;
    if (!this.bounds.width || !this.bounds.height || w <= 0 || h <= 0) return;
    const s = Math.min(w / this.bounds.width, h / this.bounds.height, 1.6);
    const scale = Math.max(MIN_SCALE, s * 0.96);
    this.setView(left + (w - this.bounds.width * scale) / 2, top + (h - this.bounds.height * scale) / 2, scale);
  }

  zoomBy(factor: number, cx?: number, cy?: number, pending = false) {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const px = cx ?? w / 2;
    const py = cy ?? h / 2;
    const ns = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.pscale * factor));
    const k = ns / this.pscale;
    this.setView(px - (px - this.ptx) * k, py - (py - this.pty) * k, ns, pending);
  }

  zoomToNode(n: SNode) {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const pad = 160;
    const s = Math.min(1.5, Math.min(w / (n.width + pad), h / (n.height + pad)));
    const scale = Math.max(this.scale, Math.min(s, 1.2));
    this.setView(w / 2 - (n.x + n.width / 2) * scale, h / 2 - (n.y + n.height / 2) * scale, scale);
  }

  /** Set the view transform; pending=true routes it through the gesture path (frame-batched, maybe composited). */
  private setView(tx: number, ty: number, scale: number, pending = false) {
    this.ptx = tx;
    this.pty = ty;
    this.pscale = scale;
    if (!pending) {
      this.commit();
      return;
    }
    if (!this.frame) this.frame = requestAnimationFrame(() => this.onFrame());
  }

  private onFrame() {
    this.frame = 0;
    if (!this.composited) {
      this.commit();
      return;
    }
    const k = this.pscale / this.scale;
    this.svg.style.transform = `translate(${(this.ptx - k * this.tx).toFixed(2)}px,${(this.pty - k * this.ty).toFixed(2)}px) scale(${k.toFixed(5)})`;
    this.svg.classList.toggle('lod-low', this.pscale < 0.35);
    // repaint at the real transform once the gesture pauses (fills in the uncovered edges)
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(() => this.commit(), this.gesturing ? PAUSE_COMMIT_MS : WHEEL_COMMIT_MS);
  }

  /** Write the pending transform to the viewport and drop any CSS transform (single repaint). */
  private commit() {
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = 0;
    }
    this.tx = this.ptx;
    this.ty = this.pty;
    this.scale = this.pscale;
    this.applyTransform();
  }

  private applyTransform() {
    this.viewport.setAttribute('transform', `translate(${this.tx.toFixed(2)},${this.ty.toFixed(2)}) scale(${this.scale.toFixed(4)})`);
    if (this.svg.style.transform) this.svg.style.transform = '';
    this.svg.classList.toggle('lod-low', this.scale < 0.35);
  }

  /** true while a transform is waiting to be committed (tests) */
  hasPendingTransform(): boolean {
    return this.frame !== 0 || this.commitTimer !== 0 || this.svg.style.transform !== '';
  }

  setHighlight(nets: string[]) {
    this.hlNets = new Set(nets);
    this.applyHighlight();
  }

  setSelected(id: string | null) {
    this.selectedId = id;
    this.applyHighlight();
  }

  /** net name -> elements that light up when the net is highlighted (built lazily per render) */
  private netIndex: Map<string, Element[]> | null = null;
  private litElements: Element[] = [];
  private selectedEl: Element | null = null;

  private buildNetIndex(): Map<string, Element[]> {
    const idx = new Map<string, Element[]>();
    const add = (net: string, el: Element) => {
      const list = idx.get(net);
      if (list) list.push(el);
      else idx.set(net, [el]);
    };
    for (const e of this.viewport.querySelectorAll<SVGGElement>('.edge')) for (const n of (e.dataset.nets ?? '').split(' ')) if (n) add(n, e);
    for (const p of this.viewport.querySelectorAll<SVGElement>('.pin')) if (p.dataset.net) add(p.dataset.net, p);
    for (const f of this.viewport.querySelectorAll<SVGGElement>('.flag')) if (f.dataset.net) add(f.dataset.net, f);
    return idx;
  }

  private applyHighlight() {
    const has = this.hlNets.size > 0;
    this.svg.classList.toggle('has-hl', has);
    for (const el of this.litElements) el.classList.remove('hl');
    this.litElements = [];
    if (has) {
      if (!this.netIndex) this.netIndex = this.buildNetIndex();
      const seen = new Set<Element>();
      for (const n of this.hlNets) {
        for (const el of this.netIndex.get(n) ?? []) {
          if (seen.has(el)) continue;
          seen.add(el);
          el.classList.add('hl');
          this.litElements.push(el);
        }
      }
    }
    if (this.selectedEl && (this.selectedEl as SVGGElement).dataset.id !== this.selectedId) {
      this.selectedEl.classList.remove('selected');
      this.selectedEl = null;
    }
    if (this.selectedId && !this.selectedEl) {
      const el = this.viewport.querySelector<SVGGElement>(`.node[data-id="${CSS.escape(this.selectedId)}"]`);
      if (el) {
        el.classList.add('selected');
        this.selectedEl = el;
      }
    }
  }

  findNode(id: string): SNode | null {
    if (!this.graph) return null;
    for (const n of allNodes(this.graph)) if (n.id === id) return n;
    return null;
  }

  /** Resolve what was hit at a client position: a net (pin/flag/edge) or a node. */
  private hitAt(target: Element | null): { nets?: string[]; node?: SNode | null } {
    if (!target) return { node: null };
    const pin = target.closest('.pin') as SVGElement | null;
    if (pin?.dataset.net) return { nets: [pin.dataset.net] };
    const flag = target.closest('.flag') as SVGGElement | null;
    if (flag?.dataset.net) return { nets: [flag.dataset.net] };
    const edge = target.closest('.edge') as SVGGElement | null;
    if (edge) return { nets: (edge.dataset.nets ?? '').split(' ').filter(Boolean) };
    const node = target.closest('.node') as SVGGElement | null;
    if (node) return { node: this.findNode(node.dataset.id!) };
    return { node: null };
  }

  private cancelGesture() {
    this.pointers.clear();
    this.pinch = null;
    this.gesturing = false;
    this.clearLongPress();
    this.container.classList.remove('panning');
  }

  private clearLongPress() {
    if (this.longPress) {
      clearTimeout(this.longPress);
      this.longPress = 0;
    }
  }

  private bind() {
    const c = this.container;
    c.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const rect = c.getBoundingClientRect();
      const factor = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015));
      this.zoomBy(factor, ev.clientX - rect.left, ev.clientY - rect.top, true);
    }, { passive: false });

    c.addEventListener('pointerdown', (ev) => {
      this.lastPointerType = ev.pointerType;
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      if (!this.svg.contains(ev.target as Node)) return; // overlays (menu, tooltip) are not part of the canvas
      this.suppressClick = false;
      this.downTarget = ev.target as Element;
      this.hideTip();
      try {
        c.setPointerCapture(ev.pointerId);
      } catch { /* ignore */ }
      this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, type: ev.pointerType });
      this.clearLongPress();
      if (this.pointers.size === 1) {
        this.gesturing = true;
        this.dragMoved = false;
        this.downX = this.lastX = ev.clientX;
        this.downY = this.lastY = ev.clientY;
        this.pinch = null;
        if (ev.pointerType === 'touch') {
          const target = ev.target as Element;
          this.longPress = window.setTimeout(() => {
            this.longPress = 0;
            if (this.pointers.size !== 1 || this.dragMoved) return;
            this.suppressClick = true;
            const rect = c.getBoundingClientRect();
            const hit = this.hitAt(target);
            this.cb.onContextMenu(hit.node ?? null, hit.nets ?? null, ev.clientX - rect.left, ev.clientY - rect.top);
          }, LONG_PRESS_MS);
        }
      } else if (this.pointers.size === 2) {
        this.startPinch();
      }
    });

    c.addEventListener('pointermove', (ev) => {
      const p = this.pointers.get(ev.pointerId);
      if (!p) {
        if (ev.pointerType === 'mouse') this.hover(ev);
        return;
      }
      p.x = ev.clientX;
      p.y = ev.clientY;
      if (this.pointers.size >= 2 && this.pinch) {
        this.dragMoved = true;
        this.clearLongPress();
        c.classList.add('panning');
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const rect = c.getBoundingClientRect();
        const mx = (a.x + b.x) / 2 - rect.left;
        const my = (a.y + b.y) / 2 - rect.top;
        const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.pinch.scale * (dist / Math.max(1, this.pinch.dist))));
        // the graph point that was under the pinch midpoint stays under the (moving) midpoint
        const gx = (this.pinch.mx - this.pinch.tx) / this.pinch.scale;
        const gy = (this.pinch.my - this.pinch.ty) / this.pinch.scale;
        this.setView(mx - gx * s, my - gy * s, s, true);
        return;
      }
      if (this.pointers.size !== 1) return;
      const dx = ev.clientX - this.lastX;
      const dy = ev.clientY - this.lastY;
      if (!this.dragMoved && Math.hypot(ev.clientX - this.downX, ev.clientY - this.downY) > TAP_SLOP) {
        this.dragMoved = true;
        this.clearLongPress();
        c.classList.add('panning');
      }
      if (!this.dragMoved) return;
      this.lastX = ev.clientX;
      this.lastY = ev.clientY;
      this.setView(this.ptx + dx, this.pty + dy, this.pscale, true);
    });

    const up = (ev: PointerEvent) => {
      if (!this.pointers.has(ev.pointerId)) return;
      this.pointers.delete(ev.pointerId);
      this.clearLongPress();
      try {
        c.releasePointerCapture(ev.pointerId);
      } catch { /* ignore */ }
      if (this.pointers.size === 1) {
        // pinch -> single finger pan continues from the remaining finger
        const rest = [...this.pointers.values()][0];
        this.pinch = null;
        this.lastX = rest.x;
        this.lastY = rest.y;
        this.dragMoved = true;
        return;
      }
      if (this.pointers.size > 0) return;
      this.gesturing = false;
      c.classList.remove('panning');
      if (this.dragMoved || this.pinch) {
        this.pinch = null;
        this.commit();
        return;
      }
      // a tap: detect double taps for touch (browsers do not deliver dblclick reliably for touch)
      if (ev.type === 'pointerup' && ev.pointerType === 'touch') {
        const now = performance.now();
        const near = Math.hypot(ev.clientX - this.lastTap.x, ev.clientY - this.lastTap.y) < 30;
        if (now - this.lastTap.t < DOUBLE_TAP_MS && near) {
          this.lastTap = { t: 0, x: 0, y: 0 };
          const hit = this.hitAt(document.elementFromPoint(ev.clientX, ev.clientY));
          if (hit.node) {
            this.suppressClick = true;
            this.cb.onOpenNode(hit.node);
          }
        } else this.lastTap = { t: now, x: ev.clientX, y: ev.clientY };
      }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('lostpointercapture', (ev) => {
      if (this.pointers.has(ev.pointerId)) up(ev);
    });

    c.addEventListener('click', (ev) => {
      // with pointer capture the click targets the container; the pointerdown target says what was hit
      const target = this.downTarget ?? (ev.target as Element);
      if (!this.svg.contains(target)) return;
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      if (this.dragMoved) {
        this.dragMoved = false;
        return;
      }
      const hit = this.hitAt(target);
      if (hit.nets) this.cb.onSelectNet(hit.nets);
      else this.cb.onSelectNode(hit.node ?? null);
    });
    c.addEventListener('dblclick', (ev) => {
      if (this.lastPointerType === 'touch') return; // handled by the double-tap detector
      const hit = this.hitAt(this.downTarget ?? (ev.target as Element));
      if (hit.node) this.cb.onOpenNode(hit.node);
    });
    c.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (this.lastPointerType === 'touch') return; // long press handles touch
      const rect = c.getBoundingClientRect();
      const hit = this.hitAt(ev.target as Element);
      this.cb.onContextMenu(hit.node ?? null, hit.nets ?? null, ev.clientX - rect.left, ev.clientY - rect.top);
    });
    c.addEventListener('pointerleave', (ev) => {
      if (ev.pointerType === 'mouse' && !this.pointers.size) this.hideTip();
    });
  }

  private startPinch() {
    const [a, b] = [...this.pointers.values()];
    const rect = this.container.getBoundingClientRect();
    this.clearLongPress();
    this.pinch = {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mx: (a.x + b.x) / 2 - rect.left,
      my: (a.y + b.y) / 2 - rect.top,
      tx: this.ptx,
      ty: this.pty,
      scale: this.pscale,
    };
  }

  private hover(ev: PointerEvent) {
    const c = this.container;
    const t = ev.target as Element;
    const tipEl = t.closest('[data-tip]') as Element | null;
    if (tipEl) {
      const rect = c.getBoundingClientRect();
      this.tooltip.textContent = tipEl.getAttribute('data-tip');
      this.tooltip.hidden = false;
      const x = ev.clientX - rect.left + 14;
      const y = ev.clientY - rect.top + 16;
      this.tooltip.style.left = `${Math.min(x, rect.width - this.tooltip.offsetWidth - 8)}px`;
      this.tooltip.style.top = `${Math.min(y, rect.height - this.tooltip.offsetHeight - 8)}px`;
    } else this.hideTip();
  }

  private hideTip() {
    this.tooltip.hidden = true;
  }

  getScale(): number {
    return this.scale;
  }

  /** current view transform (committed) */
  getView() {
    return { tx: this.tx, ty: this.ty, scale: this.scale };
  }

  /** Content bounds for export */
  getBounds() {
    return this.bounds;
  }
  getViewport() {
    return this.viewport;
  }
}
