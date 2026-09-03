import type { HierNode } from '../model/design';

export interface TreeCallbacks {
  onSelect(node: HierNode): void;
  onOpen(node: HierNode): void;
}

export class HierTree {
  private rows = new Map<string, HTMLElement>();
  private expanded = new Set<string>();
  private root: HierNode | null = null;
  /** paths whose rows currently carry the current/selected classes */
  private marked: string[] = [];
  private curPath: string | null = null;
  private selPath: string | null = null;

  constructor(private container: HTMLElement, private cb: TreeCallbacks) {}

  render(root: HierNode) {
    this.root = root;
    // expand the first two levels by default
    if (this.expanded.size === 0) {
      this.expanded.add(root.path);
      for (const c of root.children) this.expanded.add(c.path);
    }
    this.rows.clear();
    this.marked = [];
    this.container.replaceChildren(this.build([root]));
    this.applyMarks();
  }

  private build(nodes: HierNode[]): HTMLUListElement {
    const ul = document.createElement('ul');
    for (const n of nodes) {
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'row' + (n.isBlackBox ? ' bb' : '');
      row.dataset.path = n.path;
      const tw = document.createElement('span');
      tw.className = 'tw';
      const hasKids = n.children.length > 0;
      tw.textContent = hasKids ? (this.expanded.has(n.path) ? '▾' : '▸') : '';
      row.append(tw);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = n.name;
      row.append(name);
      const mod = document.createElement('span');
      mod.className = 'mod';
      mod.textContent = n.module + (n.paramText ? ` #(${n.paramText})` : '') + (n.isBlackBox ? ' (black box)' : '');
      row.append(mod);
      row.title = `${n.path}  :  ${n.module}`;
      tw.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!hasKids) return;
        if (this.expanded.has(n.path)) this.expanded.delete(n.path);
        else this.expanded.add(n.path);
        if (this.root) this.render(this.root);
      });
      row.addEventListener('click', () => this.cb.onSelect(n));
      row.addEventListener('dblclick', () => {
        if (hasKids) this.expanded.add(n.path);
        this.cb.onOpen(n);
      });
      li.append(row);
      this.rows.set(n.path, row);
      if (hasKids && this.expanded.has(n.path)) li.append(this.build(n.children));
      ul.append(li);
    }
    return ul;
  }

  /** Mark current view (module being displayed) and selected instance */
  setState(currentPath: string, selectedPath: string | null) {
    // make sure ancestors of the selection are expanded; only rebuild the DOM when that changes something
    let changed = false;
    const expand = (p: string) => {
      if (!this.expanded.has(p)) {
        this.expanded.add(p);
        changed = true;
      }
    };
    if (selectedPath) {
      const parts = selectedPath.split('/');
      for (let i = 1; i < parts.length; i++) expand(parts.slice(0, i).join('/'));
    }
    const cur = currentPath.split('/');
    for (let i = 1; i <= cur.length; i++) expand(cur.slice(0, i).join('/'));
    this.curPath = currentPath;
    this.selPath = selectedPath;
    if (this.root && (changed || !this.container.firstChild)) this.render(this.root); // render() re-applies the marks
    else this.applyMarks();
    const sel = selectedPath ? this.rows.get(selectedPath) : this.rows.get(currentPath);
    sel?.scrollIntoView({ block: 'nearest' });
  }

  private applyMarks() {
    for (const p of this.marked) this.rows.get(p)?.classList.remove('current', 'selected');
    this.marked = [];
    const mark = (p: string | null, cls: string) => {
      const row = p ? this.rows.get(p) : null;
      if (!row) return;
      row.classList.add(cls);
      this.marked.push(p!);
    };
    mark(this.curPath, 'current');
    mark(this.selPath, 'selected');
  }

  reset() {
    this.expanded.clear();
    this.rows.clear();
    this.marked = [];
  }
}
