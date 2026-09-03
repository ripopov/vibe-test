import type { SGraph, SNode } from '../model/graph';
import { allNodes } from '../model/graph';
import type { Placed } from '../layout/layout';
import { renderGraph, type RenderOptions } from '../render/schematic';

export interface ViewerCallbacks {
  onSelectNode(node: SNode | null): void;
  onSelectNet(nets: string[]): void;
  onOpenNode(node: SNode): void; // double click => descend
  onContextMenu(node: SNode | null, nets: string[] | null, x: number, y: number): void;
  onHover(tip: string | null): void;
}

export class Viewer {
  private viewport: SVGGElement;
  private tx = 0;
  private ty = 0;
  private scale = 1;
  private graph: SGraph | null = null;
  private bounds = { width: 0, height: 0 };
  private tooltip: HTMLElement;
  private dragging = false;
  private dragMoved = false;
  private lastX = 0;
  private lastY = 0;
  private hlNets = new Set<string>();
  private selectedId: string | null = null;

  constructor(private container: HTMLElement, private svg: SVGSVGElement, private cb: ViewerCallbacks) {
    this.viewport = svg.querySelector('#viewport') as SVGGElement;
    this.tooltip = container.querySelector('#tooltip') as HTMLElement;
    this.bind();
  }

  render(graph: SGraph, placed: Placed, bounds: { width: number; height: number }, opts: RenderOptions, keepView = false) {
    this.graph = graph;
    this.bounds = bounds;
    this.hideTip();
    renderGraph(this.viewport, graph, placed, opts);
    if (!keepView) this.fit();
    else this.applyTransform();
    this.applyHighlight();
  }

  get nodeCount(): number {
    let c = 0;
    if (this.graph) for (const _ of allNodes(this.graph)) c++;
    return c;
  }

  fit() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!this.bounds.width || !this.bounds.height) return;
    const s = Math.min(w / this.bounds.width, h / this.bounds.height, 1.6);
    this.scale = Math.max(0.02, s * 0.96);
    this.tx = (w - this.bounds.width * this.scale) / 2;
    this.ty = (h - this.bounds.height * this.scale) / 2;
    this.applyTransform();
  }

  zoomBy(factor: number, cx?: number, cy?: number) {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const px = cx ?? w / 2;
    const py = cy ?? h / 2;
    const ns = Math.min(8, Math.max(0.02, this.scale * factor));
    const k = ns / this.scale;
    this.tx = px - (px - this.tx) * k;
    this.ty = py - (py - this.ty) * k;
    this.scale = ns;
    this.applyTransform();
  }

  zoomToNode(n: SNode) {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const pad = 160;
    const s = Math.min(1.5, Math.min(w / (n.width + pad), h / (n.height + pad)));
    this.scale = Math.max(this.scale, Math.min(s, 1.2));
    this.tx = w / 2 - (n.x + n.width / 2) * this.scale;
    this.ty = h / 2 - (n.y + n.height / 2) * this.scale;
    this.applyTransform();
  }

  private applyTransform() {
    this.viewport.setAttribute('transform', `translate(${this.tx.toFixed(2)},${this.ty.toFixed(2)}) scale(${this.scale.toFixed(4)})`);
    this.svg.classList.toggle('lod-low', this.scale < 0.35);
  }

  setHighlight(nets: string[]) {
    this.hlNets = new Set(nets);
    this.applyHighlight();
  }

  setSelected(id: string | null) {
    this.selectedId = id;
    this.applyHighlight();
  }

  private applyHighlight() {
    const has = this.hlNets.size > 0;
    this.svg.classList.toggle('has-hl', has);
    for (const e of this.viewport.querySelectorAll<SVGGElement>('.edge')) {
      const nets = (e.dataset.nets ?? '').split(' ');
      e.classList.toggle('hl', has && nets.some((n) => this.hlNets.has(n)));
    }
    for (const p of this.viewport.querySelectorAll<SVGCircleElement>('.pin')) {
      p.classList.toggle('hl', has && this.hlNets.has(p.dataset.net ?? ''));
    }
    for (const f of this.viewport.querySelectorAll<SVGGElement>('.flag')) {
      f.classList.toggle('hl', has && this.hlNets.has(f.dataset.net ?? ''));
    }
    for (const n of this.viewport.querySelectorAll<SVGGElement>('.node')) {
      n.classList.toggle('selected', n.dataset.id === this.selectedId);
    }
  }

  findNode(id: string): SNode | null {
    if (!this.graph) return null;
    for (const n of allNodes(this.graph)) if (n.id === id) return n;
    return null;
  }

  private bind() {
    const c = this.container;
    c.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const rect = c.getBoundingClientRect();
      const factor = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015));
      this.zoomBy(factor, ev.clientX - rect.left, ev.clientY - rect.top);
    }, { passive: false });
    c.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      this.dragging = true;
      this.dragMoved = false;
      this.lastX = ev.clientX;
      this.lastY = ev.clientY;
    });
    window.addEventListener('mousemove', (ev) => {
      if (this.dragging) {
        const dx = ev.clientX - this.lastX;
        const dy = ev.clientY - this.lastY;
        if (Math.abs(dx) + Math.abs(dy) > 2) {
          this.dragMoved = true;
          c.classList.add('panning');
        }
        this.tx += dx;
        this.ty += dy;
        this.lastX = ev.clientX;
        this.lastY = ev.clientY;
        this.applyTransform();
      }
    });
    window.addEventListener('mouseup', () => {
      this.dragging = false;
      c.classList.remove('panning');
    });
    c.addEventListener('click', (ev) => {
      if (this.dragMoved) {
        this.dragMoved = false;
        return;
      }
      const t = ev.target as Element;
      const pin = t.closest('.pin') as SVGElement | null;
      if (pin) {
        const net = pin.dataset.net;
        if (net) {
          this.cb.onSelectNet([net]);
          return;
        }
      }
      const flag = t.closest('.flag') as SVGGElement | null;
      if (flag && flag.dataset.net) {
        this.cb.onSelectNet([flag.dataset.net]);
        return;
      }
      const edge = t.closest('.edge') as SVGGElement | null;
      if (edge) {
        this.cb.onSelectNet((edge.dataset.nets ?? '').split(' ').filter(Boolean));
        return;
      }
      const node = t.closest('.node') as SVGGElement | null;
      if (node) {
        this.cb.onSelectNode(this.findNode(node.dataset.id!));
        return;
      }
      this.cb.onSelectNode(null);
    });
    c.addEventListener('dblclick', (ev) => {
      const node = (ev.target as Element).closest('.node') as SVGGElement | null;
      if (node) {
        const n = this.findNode(node.dataset.id!);
        if (n) this.cb.onOpenNode(n);
      }
    });
    c.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const t = ev.target as Element;
      const rect = c.getBoundingClientRect();
      const node = t.closest('.node') as SVGGElement | null;
      const edge = t.closest('.edge') as SVGGElement | null;
      const nets = edge ? (edge.dataset.nets ?? '').split(' ').filter(Boolean) : null;
      this.cb.onContextMenu(node ? this.findNode(node.dataset.id!) : null, nets, ev.clientX - rect.left, ev.clientY - rect.top);
    });
    c.addEventListener('mousemove', (ev) => {
      if (this.dragging) {
        this.hideTip();
        return;
      }
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
    });
    c.addEventListener('mouseleave', () => this.hideTip());
  }

  private hideTip() {
    this.tooltip.hidden = true;
  }

  getScale(): number {
    return this.scale;
  }

  /** Content bounds for export */
  getBounds() {
    return this.bounds;
  }
  getViewport() {
    return this.viewport;
  }
}
