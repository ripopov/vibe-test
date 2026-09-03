import { EditorState, Compartment, StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, Decoration, type DecorationSet, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { closeBrackets } from '@codemirror/autocomplete';
import { verilog } from '@codemirror/legacy-modes/mode/verilog';
import { tags as t } from '@lezer/highlight';

const lightHighlight = HighlightStyle.define([
  { tag: t.keyword, color: '#7c3aed', fontWeight: '500' },
  { tag: [t.typeName, t.className], color: '#0f766e' },
  { tag: t.number, color: '#b45309' },
  { tag: t.string, color: '#15803d' },
  { tag: t.comment, color: '#6b7280', fontStyle: 'italic' },
  { tag: t.operator, color: '#374151' },
  { tag: t.meta, color: '#9333ea' },
  { tag: t.variableName, color: '#1f2328' },
  { tag: t.attributeName, color: '#0369a1' },
]);
const darkHighlight = HighlightStyle.define([
  { tag: t.keyword, color: '#c792ea', fontWeight: '500' },
  { tag: [t.typeName, t.className], color: '#4fd1c5' },
  { tag: t.number, color: '#f78c6c' },
  { tag: t.string, color: '#c3e88d' },
  { tag: t.comment, color: '#7f8c98', fontStyle: 'italic' },
  { tag: t.operator, color: '#89ddff' },
  { tag: t.meta, color: '#c792ea' },
  { tag: t.variableName, color: '#e5e7eb' },
  { tag: t.attributeName, color: '#82aaff' },
]);

const lightTheme = EditorView.theme({
  '&': { backgroundColor: '#ffffff', color: '#1f2328' },
  '.cm-gutters': { backgroundColor: '#f7f7f5', color: '#9ca3af', borderRight: '1px solid #e5e7eb' },
  '.cm-activeLine': { backgroundColor: '#f3f4f6' },
  '.cm-activeLineGutter': { backgroundColor: '#eceef1' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#dbeafe !important' },
  '.cm-cursor': { borderLeftColor: '#1f2328' },
}, { dark: false });
const darkTheme = EditorView.theme({
  '&': { backgroundColor: '#1b1f26', color: '#e5e7eb' },
  '.cm-gutters': { backgroundColor: '#171a20', color: '#6b7280', borderRight: '1px solid #2e3440' },
  '.cm-activeLine': { backgroundColor: '#20252d' },
  '.cm-activeLineGutter': { backgroundColor: '#20252d' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#2f3b55 !important' },
  '.cm-cursor': { borderLeftColor: '#e5e7eb' },
}, { dark: true });

// line highlight decoration for "jump to source"
const setHilite = StateEffect.define<{ from: number; to: number } | null>();
const hiliteField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setHilite)) {
        if (!e.value) return Decoration.none;
        const { from, to } = e.value;
        const doc = tr.state.doc;
        const l0 = doc.lineAt(Math.min(from, doc.length)).number;
        const l1 = doc.lineAt(Math.min(to, doc.length)).number;
        const marks = [];
        for (let l = l0; l <= Math.min(l1, l0 + 40); l++) marks.push(Decoration.line({ class: 'cm-lineHilite' }).range(doc.line(l).from));
        return Decoration.set(marks);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export class SourceEditor {
  view: EditorView;
  private themeComp = new Compartment();
  private suppressCursor = 0;
  onChange: ((doc: string) => void) | null = null;
  onCursor: ((offset: number) => void) | null = null;

  constructor(parent: HTMLElement, doc: string, dark: boolean) {
    const ext: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      history(),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      highlightSelectionMatches(),
      StreamLanguage.define(verilog),
      this.themeComp.of(dark ? [darkTheme, syntaxHighlighting(darkHighlight)] : [lightTheme, syntaxHighlighting(lightHighlight)]),
      hiliteField,
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) this.onChange?.(u.state.doc.toString());
        if (u.selectionSet && !u.docChanged && this.suppressCursor === 0 && u.transactions.some((tr) => tr.isUserEvent('select'))) {
          this.onCursor?.(u.state.selection.main.head);
        }
      }),
    ];
    this.view = new EditorView({ state: EditorState.create({ doc, extensions: ext }), parent });
  }

  setTheme(dark: boolean) {
    this.view.dispatch({ effects: this.themeComp.reconfigure(dark ? [darkTheme, syntaxHighlighting(darkHighlight)] : [lightTheme, syntaxHighlighting(lightHighlight)]) });
  }

  getDoc(): string {
    return this.view.state.doc.toString();
  }

  setDoc(doc: string) {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: doc } });
  }

  /** Scroll to a source range and highlight its lines (without triggering onCursor). */
  reveal(start: number, end: number) {
    const len = this.view.state.doc.length;
    const from = Math.max(0, Math.min(start, len));
    const to = Math.max(from, Math.min(end, len));
    this.suppressCursor++;
    try {
      this.view.dispatch({
        selection: { anchor: from },
        effects: [setHilite.of({ from, to }), EditorView.scrollIntoView(from, { y: 'center' })],
      });
    } finally {
      this.suppressCursor--;
    }
  }

  clearHilite() {
    this.view.dispatch({ effects: setHilite.of(null) });
  }

  gotoLine(line: number) {
    const doc = this.view.state.doc;
    const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
    this.reveal(l.from, l.to);
  }
}
