import './style.css';
import rvSingle from './examples/rvsimple_singlecycle.sv?raw';
import { loadDesign, buildHierarchy, resolvePath, type Design, type HierNode } from './model/design';
import { buildGraph, allNodes, allEdges, type SGraph, type SNode } from './model/graph';
import { sizeGraph } from './layout/metrics';
import { layoutGraph, type Placed } from './layout/layout';
import { schematicCss, LIGHT, DARK } from './render/schematic';
import { Viewer } from './ui/viewer';
import { SourceEditor } from './ui/editor';
import { HierTree } from './ui/tree';
import { exportSvg, downloadText } from './ui/export';
import type { Loc } from './parser/ast';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// the default example ships in the main bundle; the others are fetched on demand (keeps the phone boot small)
const EXAMPLES: Record<string, () => Promise<string>> = {
  'rvsimple-singlecycle': () => Promise.resolve(rvSingle),
  'rvsimple-multicycle': () => import('./examples/rvsimple_multicycle.sv?raw').then((m) => m.default),
  'rvsimple-pipeline': () => import('./examples/rvsimple_pipeline.sv?raw').then((m) => m.default),
  riscv: () => import('./examples/riscv.v?raw').then((m) => m.default),
  gates: () => import('./examples/gates.v?raw').then((m) => m.default),
};
const DEFAULT_EXAMPLE = 'rvsimple-singlecycle';
let exampleLoading = 0;
async function loadExample(key: string) {
  const loader = EXAMPLES[key] ?? EXAMPLES[DEFAULT_EXAMPLE];
  exampleLoading++;
  try {
    const src = await loader();
    if (exampleSelect.value !== key) return; // the user picked another one meanwhile
    loadSource(src);
  } catch (err) {
    statusEl.textContent = `Could not load example: ${(err as Error).message}`;
  } finally {
    exampleLoading--;
  }
}

interface State {
  design: Design;
  top: string;
  /** instance path from top (instance names), [] = top module itself */
  path: string[];
  expanded: Set<string>;
  graph: SGraph | null;
  placed: Placed | null;
  bounds: { width: number; height: number };
  selectedNode: SNode | null;
  hlNets: string[];
  dark: boolean;
  showTypes: boolean;
  netNames: boolean;
  labelFanout: number;
  freePinOrder: boolean;
}

const state: State = {
  design: loadDesign(''),
  top: '',
  path: [],
  expanded: new Set(),
  graph: null,
  placed: null,
  bounds: { width: 0, height: 0 },
  selectedNode: null,
  hlNets: [],
  dark: false,
  showTypes: true,
  netNames: false,
  labelFanout: 6,
  freePinOrder: true,
};

// ---- theme -----------------------------------------------------------------
const styleEl = document.createElement('style');
document.head.append(styleEl);
function applyTheme() {
  document.documentElement.dataset.theme = state.dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', state.dark ? '#1b1f26' : '#ffffff');
  styleEl.textContent = schematicCss(state.dark ? DARK : LIGHT);
  editor?.setTheme(state.dark);
  try {
    localStorage.setItem('nsv.theme', state.dark ? 'dark' : 'light');
  } catch { /* ignore */ }
}
try {
  const saved = localStorage.getItem('nsv.theme');
  if (saved) state.dark = saved === 'dark';
  else state.dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
} catch { /* ignore */ }
const params = new URLSearchParams(location.search);
if (params.get('theme')) state.dark = params.get('theme') === 'dark';
// experiments: ?opt=elk.layered.thoroughness=20&opt=...
const elkOverrides: Record<string, string> = {};
for (const o of params.getAll('opt')) {
  const i = o.indexOf('=');
  if (i > 0) elkOverrides[o.slice(0, i)] = o.slice(i + 1);
}
if (params.get('pins') === 'decl') state.freePinOrder = false;

// ---- elements --------------------------------------------------------------
const viewerEl = $('#viewer');
const svgEl = $('#svg') as unknown as SVGSVGElement;
const statusEl = $('#status');
const overlayEl = $('#overlay');
const ctxEl = $('#ctxmenu');
const crumbsEl = $('#breadcrumbs');
const topSelect = $<HTMLSelectElement>('#top-select');
const exampleSelect = $<HTMLSelectElement>('#example-select');
const diagEl = $('#diagnostics');
const diagCount = $('#diag-count');
const searchEl = $<HTMLInputElement>('#search');
const searchResults = $('#search-results');
const mbarEl = $('#mbar');
const backdropEl = $('#backdrop');
const infoCard = $('#infocard');

let editor: SourceEditor | null = null;

// ---- helpers ---------------------------------------------------------------
function moduleAtPath(design: Design, top: string, path: string[]): string | null {
  const steps = resolvePath(design, top, path);
  return steps ? steps[steps.length - 1].module : null;
}

/** parameter values of the module currently shown (instances may override defaults) */
function currentParams(): Map<string, number> | undefined {
  const steps = resolvePath(state.design, state.top, state.path);
  return steps ? steps[steps.length - 1].params : undefined;
}

function currentModule(): string | null {
  return moduleAtPath(state.design, state.top, state.path);
}

function currentPathString(): string {
  return [state.top, ...state.path].join('/');
}

// ---- mobile / desktop mode ---------------------------------------------------
// Phones (and small touch screens) get the schematic-first layout: the schematic fills the screen,
// hierarchy, source and settings live in bottom sheets. ?mobile=1|0 forces a mode (tests).
const MOBILE_QUERY = '(max-width: 820px), ((pointer: coarse) and (max-width: 1100px))';
const mobileMq = window.matchMedia(MOBILE_QUERY);
let isMobile = false;
function detectMobile(): boolean {
  const forced = params.get('mobile');
  if (forced === '1') return true;
  if (forced === '0') return false;
  return mobileMq.matches;
}
const SHEETS = ['tree-panel', 'editor-panel', 'settings-panel'] as const;
type SheetId = (typeof SHEETS)[number];
function openSheet(id: SheetId | null) {
  for (const s of SHEETS) $(`#${s}`).classList.toggle('open', s === id);
  backdropEl.hidden = !id;
  $('#m-tree').classList.toggle('active', id === 'tree-panel');
  $('#m-source').classList.toggle('active', id === 'editor-panel');
  $('#m-settings').classList.toggle('active', id === 'settings-panel');
  if (id) setSearchOpen(false);
}
function toggleSheet(id: SheetId) {
  openSheet($(`#${id}`).classList.contains('open') ? null : id);
}
function setSearchOpen(on: boolean) {
  document.documentElement.classList.toggle('search-open', on);
  $('#m-search').classList.toggle('active', on);
  if (on) {
    searchEl.focus();
    searchEl.select();
    if (searchEl.value) runSearch(searchEl.value);
  } else {
    searchResults.hidden = true;
    searchEl.blur();
  }
}
function applyMode(mobile: boolean) {
  isMobile = mobile;
  document.documentElement.classList.toggle('mobile', mobile);
  mbarEl.hidden = !mobile;
  // the breadcrumbs live in the mobile bar or in the desktop toolbar
  if (mobile) $('#m-title').append(crumbsEl);
  else $('.toolbar').prepend(crumbsEl);
  openSheet(null);
  setSearchOpen(false);
  hideContextMenu();
  updateInfoCard();
  // keep fitted content clear of the status line and the floating buttons
  viewer.setFitInsets(mobile ? { top: 28, right: 62, bottom: 8, left: 4 } : { top: 0, right: 0, bottom: 0, left: 0 });
  requestAnimationFrame(() => viewer.fit());
}

/** Selection details for touch users (replaces hover tooltips and the desktop context menu). */
function updateInfoCard() {
  if (!isMobile) {
    infoCard.hidden = true;
    return;
  }
  const titleEl = $('#ic-title');
  const tipEl = $('#ic-tip');
  const actions = $('#ic-actions');
  actions.replaceChildren();
  const add = (label: string, fn: () => void, primary = false) => {
    const b = document.createElement('button');
    b.className = 'btn' + (primary ? ' primary' : '');
    b.textContent = label;
    b.addEventListener('click', fn);
    actions.append(b);
  };
  const node = state.selectedNode;
  if (node && state.graph) {
    titleEl.textContent = node.kind === 'inst' ? `${node.title} : ${node.moduleName ?? ''}` : node.title;
    const tip = node.tooltip ?? '';
    // instance tooltips repeat "module name": only show them when they add parameters or notes
    tipEl.textContent = tip === node.title || (node.kind === 'inst' && !/#\(|\(black box\)|\[/.test(tip)) ? '' : tip;
    if (node.kind === 'inst' && node.instPath) {
      const canDescend = !!node.moduleName && state.design.modules.has(node.moduleName);
      if (canDescend) {
        add('Descend', () => navigateTo([...state.path, ...node.instPath!.split('/')]), true);
        add(state.expanded.has(node.instPath) ? 'Collapse' : 'Expand', () => toggleExpand(node));
      }
    }
    add('Zoom', () => viewer.zoomToNode(node));
    if (node.loc) add('Source', () => revealSource(node.loc!.start, node.loc!.end));
    infoCard.hidden = false;
    return;
  }
  if (state.hlNets.length && state.graph) {
    const named = state.hlNets.filter((n) => !n.startsWith('~'));
    const info = named.map((n) => state.graph!.nets.get(n)).find((i) => i);
    titleEl.textContent = named.slice(0, 3).join(', ') + (named.length > 3 ? ` +${named.length - 3}` : '');
    tipEl.textContent = info ? `${info.isPort ? 'port ' : 'net '}${info.width > 1 ? `[${info.msb}:${info.lsb}] ` : ''}${info.name} · ${info.drivers.length} driver(s), ${info.sinks.length} sink(s)` : '';
    if (info?.loc) add('Source', () => revealSource(info.loc!.start, info.loc!.end));
    infoCard.hidden = false;
    return;
  }
  infoCard.hidden = true;
}

/** Jump the editor to a source range; on mobile also opens the source sheet. */
function revealSource(start: number, end: number) {
  editor?.reveal(start, end);
  if (isMobile) openSheet('editor-panel');
}

// ---- rendering pipeline ----------------------------------------------------
let layoutSeq = 0;
let layoutRunning = false;

async function relayout(keepView = false) {
  const mod = currentModule();
  const seq = ++layoutSeq;
  if (!mod) {
    state.graph = null;
    viewerEl.querySelector('#viewport')!.replaceChildren();
    statusEl.textContent = state.design.modules.size ? 'Module not found' : 'No modules parsed';
    renderCrumbs();
    return;
  }
  const t0 = performance.now();
  const graph = buildGraph(state.design, mod, { expanded: state.expanded, labelFanout: state.labelFanout }, '', currentParams());
  sizeGraph(graph, { showTypes: state.showTypes });
  const nNodes = [...allNodes(graph)].length;
  const nEdges = [...allEdges(graph)].length;
  overlayEl.innerHTML = `<div><span class="spinner"></span>Laying out ${nNodes} nodes, ${nEdges} wires…</div>`;
  overlayEl.hidden = false;
  layoutRunning = true;
  try {
    const res = await layoutGraph(graph, {
      showTypes: state.showTypes,
      spacing: nNodes > 600 ? 0.8 : 1,
      thoroughness: nNodes > 400 ? 1 : nNodes > 150 ? 7 : 30,
      netNames: state.netNames,
      freePinOrder: state.freePinOrder,
      overrides: elkOverrides,
    });
    if (seq !== layoutSeq) return; // superseded
    state.graph = graph;
    state.placed = res.placed;
    state.bounds = { width: res.width, height: res.height };
    viewer.render(graph, res.placed, state.bounds, { showTypes: state.showTypes }, keepView);
    const total = performance.now() - t0;
    statusEl.textContent = `${mod} · ${nNodes} nodes · ${nEdges} wires · layout ${res.ms.toFixed(0)} ms · total ${total.toFixed(0)} ms`;
    restoreSelection();
  } catch (err) {
    if (seq !== layoutSeq) return;
    statusEl.textContent = `Layout failed: ${(err as Error).message}`;
    console.error(err);
  } finally {
    if (seq === layoutSeq) {
      overlayEl.hidden = true;
      layoutRunning = false;
    }
  }
  renderCrumbs();
  tree.setState(currentPathString(), state.selectedNode?.instPath ? `${currentPathString()}/${state.selectedNode.instPath}` : null);
}

function restoreSelection() {
  if (state.selectedNode && state.graph) {
    const again = [...allNodes(state.graph)].find((n) => n.refKind === state.selectedNode!.refKind && n.refName === state.selectedNode!.refName && n.instPath === state.selectedNode!.instPath);
    state.selectedNode = again ?? null;
  }
  viewer.setSelected(state.selectedNode?.id ?? null);
  viewer.setHighlight(state.hlNets);
  updateInfoCard();
}

// ---- source handling -------------------------------------------------------
let parseTimer: number | null = null;
function sourceChanged(src: string, immediate = false, fitAfter = false) {
  if (parseTimer) window.clearTimeout(parseTimer);
  const run = () => {
    parseTimer = null;
    const prevTop = state.top;
    state.design = loadDesign(src);
    renderDiagnostics();
    fillTopSelect();
    if (!state.design.modules.has(prevTop)) {
      state.top = state.design.tops[0] ?? '';
      state.path = [];
      state.expanded.clear();
      tree.reset();
    } else {
      // keep the path if still valid
      while (state.path.length && !moduleAtPath(state.design, state.top, state.path)) state.path.pop();
    }
    topSelect.value = state.top;
    if (state.top) tree.render(buildHierarchy(state.design, state.top));
    else tree.render({ name: '(no modules)', module: '', path: '', children: [], isBlackBox: true });
    void relayout(!fitAfter && state.design.modules.has(prevTop));
  };
  if (immediate) run();
  else parseTimer = window.setTimeout(run, 350);
}

function fillTopSelect() {
  topSelect.replaceChildren();
  const names = [...state.design.modules.keys()];
  const tops = new Set(state.design.tops);
  for (const n of [...state.design.tops, ...names.filter((x) => !tops.has(x))]) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = tops.has(n) ? n : `  ${n}`;
    topSelect.append(o);
  }
}

function renderDiagnostics() {
  const diags = state.design.parse.diagnostics;
  diagEl.replaceChildren();
  const errs = diags.filter((d) => d.severity === 'error').length;
  diagCount.textContent = diags.length ? `${errs} errors, ${diags.length - errs} warnings` : `${state.design.modules.size} modules`;
  diagCount.classList.toggle('err', errs > 0);
  for (const d of diags.slice(0, 200)) {
    const row = document.createElement('div');
    row.className = `d ${d.severity}`;
    row.innerHTML = `<span class="ln">${d.line}:</span>${escapeHtml(d.message)}`;
    row.addEventListener('click', () => revealSource(d.start, d.end));
    diagEl.append(row);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
}

// ---- navigation --------------------------------------------------------------
function navigateTo(path: string[], selectInst?: string) {
  state.path = path;
  state.expanded.clear();
  state.hlNets = [];
  state.selectedNode = null;
  if (selectInst) {
    state.selectedNode = { refKind: 'instance', refName: selectInst, instPath: selectInst } as SNode;
  }
  void relayout(false);
}

function renderCrumbs() {
  crumbsEl.replaceChildren();
  const parts = [state.top, ...state.path];
  parts.forEach((p, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '›';
      crumbsEl.append(sep);
    }
    const isLast = i === parts.length - 1;
    const el = document.createElement(isLast ? 'span' : 'a');
    el.className = isLast ? 'cur' : '';
    const mod = moduleAtPath(state.design, state.top, parts.slice(1, i + 1));
    el.textContent = i === 0 ? p : p;
    el.title = mod ?? '';
    if (!isLast) el.addEventListener('click', () => navigateTo(parts.slice(1, i + 1), parts[i + 1]));
    crumbsEl.append(el);
  });
  const mod = currentModule();
  if (mod && parts.length > 1) {
    const m = document.createElement('span');
    m.className = 'sep';
    m.textContent = `(${mod})`;
    crumbsEl.append(m);
  }
  ($('#m-up') as HTMLButtonElement).disabled = state.path.length === 0;
  if (isMobile) crumbsEl.querySelector('.cur')?.scrollIntoView({ inline: 'end', block: 'nearest' });
}

// ---- selection sync ----------------------------------------------------------
function selectNode(node: SNode | null, fromEditor = false) {
  state.selectedNode = node;
  state.hlNets = [];
  viewer.setSelected(node?.id ?? null);
  viewer.setHighlight([]);
  if (node?.loc && !fromEditor) editor?.reveal(node.loc.start, node.loc.end);
  tree.setState(currentPathString(), node?.instPath ? `${currentPathString()}/${node.instPath}` : null);
  updateInfoCard();
}

function selectNets(nets: string[], fromEditor = false) {
  state.selectedNode = null;
  // expand alias groups: any edge that shares a net joins the highlight
  const set = new Set(nets);
  if (state.graph) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of allEdges(state.graph)) {
        if (e.nets.some((n) => set.has(n))) for (const n of e.nets) if (!set.has(n)) {
          set.add(n);
          grew = true;
        }
      }
    }
  }
  state.hlNets = [...set];
  viewer.setSelected(null);
  viewer.setHighlight(state.hlNets);
  if (!fromEditor && state.graph) {
    const named = nets.find((n) => !n.startsWith('~')) ?? [...set].find((n) => !n.startsWith('~'));
    const info = named ? state.graph.nets.get(named) : null;
    if (info?.loc) editor?.reveal(info.loc.start, info.loc.end);
  }
  tree.setState(currentPathString(), null);
  updateInfoCard();
}

/** Editor cursor moved: find the element at the offset and highlight it. */
function cursorMoved(offset: number) {
  const mod = currentModule();
  if (!mod || !state.graph) return;
  const mi = state.design.modules.get(mod)!;
  const inside = (l: Loc | undefined) => !!l && offset >= l.start && offset <= l.end;
  // is the cursor inside another module? navigate there
  if (!inside(mi.ast.loc)) {
    const other = state.design.parse.modules.find((m) => inside(m.loc));
    if (other && state.design.modules.has(other.name)) {
      // find a path from top to that module if possible; else set as top
      const p = findPathToModule(state.top, other.name);
      if (p) {
        state.path = p;
      } else {
        state.top = other.name;
        state.path = [];
        topSelect.value = state.top;
        tree.reset();
        tree.render(buildHierarchy(state.design, state.top));
      }
      state.expanded.clear();
      state.selectedNode = null;
      state.hlNets = [];
      void relayout(false).then(() => cursorMoved(offset));
    }
    return;
  }
  // instances
  for (const n of state.graph.nodes) {
    if (n.kind === 'inst' && inside(n.loc)) {
      // inside a specific connection? -> highlight that net
      const pin = n.pins.find((p) => inside(p.loc));
      if (pin?.netKey) {
        selectNets([pin.netKey], true);
        viewer.setSelected(n.id);
        state.selectedNode = n;
        return;
      }
      selectNode(n, true);
      return;
    }
  }
  for (const n of state.graph.nodes) {
    if (n.kind === 'port' && inside(n.loc)) {
      selectNets([n.refName], true);
      return;
    }
  }
  for (const n of state.graph.nodes) {
    if ((n.kind === 'expr' || n.kind === 'const' || n.kind === 'proc') && inside(n.loc)) {
      selectNode(n, true);
      return;
    }
  }
  // net declarations / assign statements
  for (const net of state.graph.nets.values()) {
    if (inside(net.loc)) {
      selectNets([net.name], true);
      return;
    }
  }
  for (const a of mi.ast.assigns) {
    if (inside(a.loc)) {
      const names = new Set<string>();
      collectRefNames(a.lhs, names);
      if (names.size) {
        selectNets([...names], true);
        return;
      }
    }
  }
}

function collectRefNames(e: import('./parser/ast').Expr, out: Set<string>) {
  if (e.kind === 'id') out.add(e.name);
  else if (e.kind === 'select' || e.kind === 'range') collectRefNames(e.base, out);
  else if (e.kind === 'concat') e.items.forEach((i) => collectRefNames(i, out));
}

function findPathToModule(from: string, target: string, seen = new Set<string>()): string[] | null {
  if (from === target) return [];
  if (seen.has(from)) return null;
  seen.add(from);
  const mi = state.design.modules.get(from);
  if (!mi) return null;
  for (const inst of mi.ast.instances) {
    const sub = findPathToModule(inst.module, target, seen);
    if (sub) return [inst.name, ...sub];
  }
  return null;
}

// ---- viewer ----------------------------------------------------------------
const viewer = new Viewer(viewerEl, svgEl, {
  onSelectNode: (n) => selectNode(n),
  onSelectNet: (nets) => selectNets(nets),
  onOpenNode: (n) => {
    if (n.kind === 'inst' && n.moduleName && state.design.modules.has(n.moduleName) && n.instPath) {
      navigateTo([...state.path, ...n.instPath.split('/')]);
    }
  },
  onContextMenu: (node, nets, x, y) => showContextMenu(node, nets, x, y),
  onHover: () => { /* tooltips handled inside viewer */ },
});

function showContextMenu(node: SNode | null, nets: string[] | null, x: number, y: number) {
  ctxEl.replaceChildren();
  const add = (label: string, fn: (() => void) | null) => {
    const it = document.createElement('div');
    it.className = 'item' + (fn ? '' : ' disabled');
    it.textContent = label;
    if (fn) it.addEventListener('click', () => {
      hideContextMenu();
      fn();
    });
    ctxEl.append(it);
  };
  if (node?.kind === 'inst' && node.instPath) {
    const canDescend = !!node.moduleName && state.design.modules.has(node.moduleName);
    const isExpanded = state.expanded.has(node.instPath);
    add(isExpanded ? 'Collapse instance' : 'Expand in place', canDescend ? () => toggleExpand(node) : null);
    add('Descend into instance', canDescend ? () => navigateTo([...state.path, ...node.instPath!.split('/')]) : null);
    add('Zoom to instance', () => viewer.zoomToNode(node));
    add('Go to source', node.loc ? () => revealSource(node.loc!.start, node.loc!.end) : null);
  } else if (node) {
    add('Go to source', node.loc ? () => revealSource(node.loc!.start, node.loc!.end) : null);
  } else if (nets) {
    add('Highlight net', () => selectNets(nets));
    add('Go to declaration', () => selectNets(nets));
  } else {
    add('Fit to view', () => viewer.fit());
    add('Collapse all', () => {
      state.expanded.clear();
      void relayout(false);
    });
    if (state.path.length) add('Go up', () => navigateTo(state.path.slice(0, -1), state.path[state.path.length - 1]));
  }
  ctxEl.hidden = false;
  const vw = viewerEl.clientWidth;
  const vh = viewerEl.clientHeight;
  ctxEl.style.left = `${Math.max(0, Math.min(x, vw - ctxEl.offsetWidth - 4))}px`;
  ctxEl.style.top = `${Math.max(0, Math.min(y, vh - ctxEl.offsetHeight - 4))}px`;
}
function hideContextMenu() {
  ctxEl.hidden = true;
}
window.addEventListener('pointerdown', (ev) => {
  if (!ctxEl.contains(ev.target as Node)) hideContextMenu();
  if (!searchResults.contains(ev.target as Node) && ev.target !== searchEl && !(ev.target as Element).closest?.('#m-search')) searchResults.hidden = true;
});

function toggleExpand(node: SNode) {
  if (!node.instPath) return;
  if (state.expanded.has(node.instPath)) {
    // also collapse descendants
    for (const p of [...state.expanded]) if (p === node.instPath || p.startsWith(node.instPath + '/')) state.expanded.delete(p);
  } else state.expanded.add(node.instPath);
  state.selectedNode = node;
  void relayout(true);
}

// ---- tree ------------------------------------------------------------------
const tree = new HierTree($('#tree'), {
  onSelect: (h: HierNode) => {
    if (isMobile) openSheet(null);
    const parts = h.path.split('/');
    if (parts.length === 1) {
      navigateTo([]);
      return;
    }
    const parentPath = parts.slice(1, -1);
    const inst = parts[parts.length - 1];
    const samePath = parentPath.join('/') === state.path.join('/');
    if (samePath && state.graph) {
      const n = state.graph.nodes.find((x) => x.kind === 'inst' && x.refName === inst);
      if (n) {
        selectNode(n);
        viewer.zoomToNode(n);
        return;
      }
    }
    navigateTo(parentPath, inst);
  },
  onOpen: (h: HierNode) => {
    if (h.isBlackBox) return;
    if (isMobile) openSheet(null);
    navigateTo(h.path.split('/').slice(1));
  },
});

// ---- search ----------------------------------------------------------------
interface SearchItem {
  kind: string;
  label: string;
  path: string;
  run: () => void;
}
let searchItems: SearchItem[] = [];
let searchActive = -1;
function runSearch(q: string) {
  searchItems = [];
  searchActive = -1;
  const query = q.trim().toLowerCase();
  if (!query) {
    searchResults.hidden = true;
    return;
  }
  const g = state.graph;
  if (g) {
    for (const n of allNodes(g)) {
      if (n.kind === 'inst' && (n.title.toLowerCase().includes(query) || (n.moduleName ?? '').toLowerCase().includes(query))) {
        searchItems.push({ kind: 'instance', label: `${n.title} : ${n.moduleName}`, path: currentPathString(), run: () => {
          selectNode(n);
          viewer.zoomToNode(n);
        } });
      } else if (n.kind === 'port' && n.title.toLowerCase().includes(query)) {
        searchItems.push({ kind: 'port', label: n.title, path: currentPathString(), run: () => {
          selectNets([n.refName]);
          viewer.zoomToNode(n);
        } });
      }
    }
    for (const net of g.nets.values()) {
      if (net.isPort) continue;
      if (net.name.toLowerCase().includes(query) && (net.sinks.length || net.drivers.length || net.aliases.length)) {
        searchItems.push({ kind: 'net', label: net.name + (net.width > 1 ? ` [${net.msb}:${net.lsb}]` : ''), path: currentPathString(), run: () => selectNets([net.name]) });
      }
    }
  }
  // hierarchy-wide instance search
  if (state.top) {
    const walk = (h: HierNode) => {
      for (const c of h.children) {
        if (c.path !== currentPathString() && (c.name.toLowerCase().includes(query) || c.module.toLowerCase().includes(query))) {
          const parts = c.path.split('/');
          if (parts.slice(1, -1).join('/') !== state.path.join('/')) {
            searchItems.push({ kind: 'hier', label: `${c.name} : ${c.module}`, path: parts.slice(0, -1).join('/'), run: () => navigateTo(parts.slice(1, -1), parts[parts.length - 1]) });
          }
        }
        if (searchItems.length < 400) walk(c);
      }
    };
    walk(buildHierarchy(state.design, state.top));
  }
  searchItems = searchItems.slice(0, 60);
  renderSearch();
}
function renderSearch() {
  searchResults.replaceChildren();
  if (!searchItems.length) {
    const d = document.createElement('div');
    d.className = 'item';
    d.textContent = 'No matches';
    searchResults.append(d);
  }
  searchItems.forEach((it, i) => {
    const d = document.createElement('div');
    d.className = 'item' + (i === searchActive ? ' active' : '');
    d.innerHTML = `<span class="kind">${it.kind}</span><span>${escapeHtml(it.label)}</span><span class="path">${escapeHtml(it.path)}</span>`;
    d.addEventListener('click', () => {
      it.run();
      searchResults.hidden = true;
      if (isMobile) setSearchOpen(false);
    });
    searchResults.append(d);
  });
  searchResults.hidden = false;
}
searchEl.addEventListener('input', () => runSearch(searchEl.value));
searchEl.addEventListener('focus', () => {
  if (searchEl.value) runSearch(searchEl.value);
});
searchEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown') {
    searchActive = Math.min(searchItems.length - 1, searchActive + 1);
    renderSearch();
    ev.preventDefault();
  } else if (ev.key === 'ArrowUp') {
    searchActive = Math.max(0, searchActive - 1);
    renderSearch();
    ev.preventDefault();
  } else if (ev.key === 'Enter') {
    const it = searchItems[Math.max(0, searchActive)];
    if (it) {
      it.run();
      searchResults.hidden = true;
      if (isMobile) setSearchOpen(false);
    }
  } else if (ev.key === 'Escape') {
    searchResults.hidden = true;
    searchEl.blur();
  }
});

// ---- toolbar -----------------------------------------------------------------
$('#fit-btn').addEventListener('click', () => viewer.fit());
$('#zoom-in').addEventListener('click', () => viewer.zoomBy(1.25));
$('#zoom-out').addEventListener('click', () => viewer.zoomBy(0.8));
$('#expand-btn').addEventListener('click', () => {
  if (state.selectedNode?.kind === 'inst') toggleExpand(state.selectedNode);
});
$('#collapse-btn').addEventListener('click', () => {
  state.expanded.clear();
  void relayout(true);
});
$('#export-btn').addEventListener('click', () => {
  const mod = currentModule() ?? 'schematic';
  const svg = exportSvg(viewer.getViewport(), state.bounds, state.dark ? DARK : LIGHT, mod);
  downloadText(`${mod}.svg`, svg);
});
// mobile bar, sheets, floating buttons
$('#m-up').addEventListener('click', () => {
  if (state.path.length) navigateTo(state.path.slice(0, -1), state.path[state.path.length - 1]);
});
$('#m-search').addEventListener('click', () => {
  openSheet(null);
  setSearchOpen(!document.documentElement.classList.contains('search-open'));
});
$('#m-tree').addEventListener('click', () => toggleSheet('tree-panel'));
$('#m-source').addEventListener('click', () => toggleSheet('editor-panel'));
$('#m-settings').addEventListener('click', () => toggleSheet('settings-panel'));
for (const b of document.querySelectorAll<HTMLElement>('[data-close]')) b.addEventListener('click', () => openSheet(null));
backdropEl.addEventListener('click', () => openSheet(null));
$('#ic-close').addEventListener('click', () => selectNode(null));
$('#m-fit').addEventListener('click', () => viewer.fit());
$('#m-zoom-in').addEventListener('click', () => viewer.zoomBy(1.25));
$('#m-zoom-out').addEventListener('click', () => viewer.zoomBy(0.8));
mobileMq.addEventListener('change', () => applyMode(detectMobile()));
// orientation change: the schematic keeps fitting the screen
let fitTimer = 0;
const refit = () => {
  if (!isMobile) return;
  if (fitTimer) clearTimeout(fitTimer);
  fitTimer = window.setTimeout(() => viewer.fit(), 120);
};
screen.orientation?.addEventListener('change', refit);
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && isMobile) {
    openSheet(null);
    setSearchOpen(false);
  }
});

$('#theme-btn').addEventListener('click', () => {
  state.dark = !state.dark;
  applyTheme();
});
$('#editor-btn').addEventListener('click', () => {
  $('#editor-panel').classList.toggle('collapsed');
  $('#split-right').classList.toggle('collapsed');
  $('#editor-btn').classList.toggle('active', !$('#editor-panel').classList.contains('collapsed'));
});
$('#editor-btn').classList.add('active');
$<HTMLInputElement>('#opt-types').addEventListener('change', (ev) => {
  state.showTypes = (ev.target as HTMLInputElement).checked;
  void relayout(true);
});
$<HTMLInputElement>('#opt-pins').addEventListener('change', (ev) => {
  state.freePinOrder = (ev.target as HTMLInputElement).checked;
  void relayout(true);
});
$<HTMLInputElement>('#opt-netnames').addEventListener('change', (ev) => {
  state.netNames = (ev.target as HTMLInputElement).checked;
  void relayout(true);
});
$<HTMLInputElement>('#opt-fanout').addEventListener('change', (ev) => {
  state.labelFanout = Math.max(2, parseInt((ev.target as HTMLInputElement).value, 10) || 6);
  void relayout(true);
});
topSelect.addEventListener('change', () => {
  state.top = topSelect.value;
  state.path = [];
  state.expanded.clear();
  state.selectedNode = null;
  state.hlNets = [];
  tree.reset();
  tree.render(buildHierarchy(state.design, state.top));
  void relayout(false);
});
exampleSelect.addEventListener('change', () => void loadExample(exampleSelect.value));
$('#open-btn').addEventListener('click', () => $<HTMLInputElement>('#file-input').click());
$<HTMLInputElement>('#file-input').addEventListener('change', async (ev) => {
  const files = (ev.target as HTMLInputElement).files;
  if (files?.length) await loadFiles([...files]);
});

async function loadFiles(files: File[]) {
  const parts: string[] = [];
  for (const f of files) parts.push(`// ---- file: ${f.name}\n${await f.text()}`);
  loadSource(parts.join('\n\n'));
}

function loadSource(src: string) {
  state.top = '';
  state.path = [];
  state.expanded.clear();
  state.selectedNode = null;
  state.hlNets = [];
  tree.reset();
  editor?.setDoc(src);
  sourceChanged(src, true, true);
}

// drag & drop
const dropHint = $('#drop-hint');
window.addEventListener('dragover', (ev) => {
  ev.preventDefault();
  dropHint.hidden = false;
});
window.addEventListener('dragleave', (ev) => {
  if ((ev as DragEvent).relatedTarget === null) dropHint.hidden = true;
});
window.addEventListener('drop', async (ev) => {
  ev.preventDefault();
  dropHint.hidden = true;
  const files = ev.dataTransfer?.files;
  if (files?.length) await loadFiles([...files]);
});

// keyboard
window.addEventListener('keydown', (ev) => {
  const inEditor = (ev.target as HTMLElement).closest('.cm-editor, input, select, textarea');
  if (inEditor) return;
  if (ev.key === 'f' || ev.key === 'F') viewer.fit();
  else if (ev.key === '+' || ev.key === '=') viewer.zoomBy(1.25);
  else if (ev.key === '-') viewer.zoomBy(0.8);
  else if (ev.key === '/') {
    ev.preventDefault();
    searchEl.focus();
    searchEl.select();
  } else if (ev.key === 'Escape') {
    selectNode(null);
    editor?.clearHilite();
  } else if (ev.key === 'e' || ev.key === 'E') {
    if (state.selectedNode?.kind === 'inst') toggleExpand(state.selectedNode);
  } else if (ev.key === 'Backspace' || (ev.altKey && ev.key === 'ArrowLeft')) {
    if (state.path.length) navigateTo(state.path.slice(0, -1), state.path[state.path.length - 1]);
  } else if (ev.key === 'Enter') {
    const n = state.selectedNode;
    if (n?.kind === 'inst' && n.moduleName && state.design.modules.has(n.moduleName) && n.instPath) navigateTo([...state.path, ...n.instPath.split('/')]);
  }
});

// splitters
function makeSplitter(splitter: HTMLElement, panel: HTMLElement, fromRight: boolean) {
  let startX = 0;
  let startW = 0;
  splitter.addEventListener('mousedown', (ev) => {
    startX = ev.clientX;
    startW = panel.getBoundingClientRect().width;
    const move = (e: MouseEvent) => {
      const d = e.clientX - startX;
      panel.style.width = `${Math.max(160, startW + (fromRight ? -d : d))}px`;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    ev.preventDefault();
  });
}
makeSplitter($('#split-left'), $('#tree-panel'), false);
makeSplitter($('#split-right'), $('#editor-panel'), true);

// ---- boot ------------------------------------------------------------------
const initialExample = params.get('example') ?? DEFAULT_EXAMPLE;
exampleSelect.value = EXAMPLES[initialExample] ? initialExample : DEFAULT_EXAMPLE;
const initialSrc = await EXAMPLES[exampleSelect.value]();
editor = new SourceEditor($('#editor'), initialSrc, state.dark);
editor.onChange = (doc) => sourceChanged(doc);
editor.onCursor = (off) => cursorMoved(off);
applyTheme();
applyMode(detectMobile());
if (params.get('editor') === '0') $('#editor-btn').click();
sourceChanged(initialSrc, true, true);
if (params.get('path')) {
  const p = params.get('path')!.split('/').filter(Boolean);
  state.path = p;
  void relayout(false);
}
$<HTMLInputElement>('#opt-pins').checked = state.freePinOrder;
if (params.get('types') === '0') {
  state.showTypes = false;
  $<HTMLInputElement>('#opt-types').checked = false;
}

// expose for debugging / screenshot automation
(window as unknown as { nsv: unknown }).nsv = {
  state,
  relayout,
  navigateTo,
  viewer,
  editor,
  selectNode,
  selectNets,
  toggleExpand,
  exportSvg: () => exportSvg(viewer.getViewport(), state.bounds, state.dark ? DARK : LIGHT, currentModule() ?? 'schematic'),
  setTheme: (dark: boolean) => {
    state.dark = dark;
    applyTheme();
  },
  isBusy: () => layoutRunning || parseTimer !== null || exampleLoading > 0,
  isMobile: () => isMobile,
  openSheet,
  setGestureMode: (m: 'auto' | 'direct' | 'composited') => viewer.setGestureMode(m),
};
