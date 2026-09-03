# Netlist Schematic Viewer

A single-page web app that draws clean, readable schematics from Verilog
netlists (modules made of ports, wires, `assign`s and sub-module instances).
No backend: parsing, elaboration and layout all run in the browser, with the
ELK layered algorithm in a web worker.

```
npm install
npm run dev        # http://localhost:5173
npm run build      # static bundle in dist/
npm test           # parser + layout unit tests
npm run shot -- "http://localhost:4173/?editor=0&path=u_core" shots/core.png
```

## Layout

* **Left** – hierarchy browser. Click selects the instance in its parent's
  schematic, double-click descends into it.
* **Center** – schematic. Breadcrumbs, pan (drag) / zoom (wheel), search (`/`),
  click a wire or pin to highlight the whole net, hover for tooltips,
  right-click an instance to expand it in place, `Export SVG`.
* **Right** (collapsible, `☰`) – Verilog editor with syntax highlighting.
  Edits re-parse and re-render live; selecting something in the schematic
  jumps to its source line, and moving the cursor in the source selects the
  corresponding instance / net in the schematic.

Drop `.v`/`.sv` files anywhere on the window to load them. Light/dark theme
with `◐`.

## Drawing conventions

* Left-to-right signal flow, orthogonal wires, junction dots on fan-out.
* Buses are thick and labelled with their width at the driver; bit/part
  selects are labelled at the pin (`[7:0]`).
* Nets with a fan-out ≥ *fanout* (toolbar) and clock/reset-like nets are drawn
  as labels next to the pins instead of wires.
* Constants become tags on the pin, concatenations become bus rippers,
  expressions become operator boxes (with gate symbols for `& | ^ ~ ?:`), and
  `assign a = b` aliases are drawn as a single wire.
* Standard-cell like module names (`NAND2_X1`, `INV_X1`, `DFFR_X1`, …) are
  drawn as gate symbols even when the cell definitions are missing (black boxes
  are otherwise dashed boxes with pin directions guessed from the netlist).
* "optimize pins" lets the layout reorder the pins on each side of a box to
  reduce crossings; turn it off to keep declaration order.

## Parser

Tolerant, hand-written recursive descent parser for the structural subset of
Verilog-2005 / SystemVerilog: ANSI and non-ANSI ports, parameters (evaluated
for widths), named / positional / `.*` connections, bit and part selects,
concatenations and replication, constants, instance arrays, escaped
identifiers, attributes and compiler directives. Behavioural blocks
(`always`, `initial`, functions, generate) are skipped, so a module with only
behavioural code shows up as a leaf with ports. Parse errors are reported in
the editor panel and never stop rendering of the rest of the file.

## Examples

* **RISC-V SoC** – a small hierarchical RV32I core with memories and
  peripherals (`src/examples/riscv.v`).
* **Gate-level netlist** – a flat, generated 1.5k-cell pipelined design
  (`src/examples/gates.v`, `npm run gen:gates -- 1500`).

## Layout pipeline

`parser/` → `model/design.ts` (elaboration, parameter evaluation) →
`model/graph.ts` (nodes / pins / nets, driver resolution through aliases and
slices, net-label heuristics) → `layout/metrics.ts` (text measurement, node
sizing) → `layout/layout.ts` (ELK graph, options, worker) →
`render/schematic.ts` (SVG).

Layout strategy scales with the graph: small modules use ELK's network-simplex
node placement with high thoroughness, medium ones Brandes-Köpf, and flat
netlists above 400 nodes the compact SIMPLE placer with flat hierarchy handling
(a 1.5k-cell netlist lays out in about one second).

`scripts/screenshot.mjs` renders a view with headless Chrome and reports
wire/box crossings, label overlaps, wire/label overlaps, edge crossings,
bends and total wire length; `scripts/interact.mjs` runs end-to-end
interaction checks.
