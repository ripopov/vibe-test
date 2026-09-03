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
* Procedural blocks (`always_ff`, `always_comb`, `always @*`) are drawn as
  rounded *process* boxes with one input pin per signal the block reads and
  one output pin per signal it assigns; edge-sensitive clocks get a clock
  triangle. A register written by `always_ff` therefore looks like a flop
  whose D inputs are the nets its next-state logic depends on.
* Unpacked arrays (`logic [31:0] mem [0:255]`) are nets whose wires carry a
  `256×32` width label; constant element selects (`pc[PL_ID]`) are separate
  nets, and dynamic reads (`mem[addr]`) are expression boxes.
* Standard-cell like module names (`NAND2_X1`, `INV_X1`, `DFFR_X1`, …) are
  drawn as gate symbols even when the cell definitions are missing (black boxes
  are otherwise dashed boxes with pin directions guessed from the netlist).
* "optimize pins" lets the layout reorder the pins on each side of a box to
  reduce crossings; turn it off to keep declaration order.

## Parser

Tolerant, hand-written recursive descent parser for Verilog-2005 /
SystemVerilog netlists and simple RTL:

* ANSI and non-ANSI ports, `logic`/`wire`/`reg` with packed and unpacked
  dimensions, parameters and localparams (evaluated for widths, including
  `$clog2` and `**`), named / positional / `.*` connections, bit and part
  selects (`[a:b]`, `+:`), concatenations, replication, constants, instance
  arrays, escaped identifiers, attributes.
* Preprocessor: `` `define`` (with arguments), `` `undef``, `` `ifdef`` /
  `` `ifndef`` / `` `elsif`` / `` `else`` / `` `endif`` and macro expansion;
  tokens from a macro keep the source location of the macro usage so editor
  synchronisation still works. `` `include`` is ignored (single-file viewer).
* Per-instance parameter overrides: `mux #(.WIDTH(8), .CHANNELS(4)) u (...)`
  sizes the pins of `u` and, when you descend into it, the ports and generate
  loops of the child are elaborated with those values. The hierarchy tree
  shows non-default parameters.
* `generate` `for` / `if` blocks are unrolled (genvars become constants,
  labelled blocks prefix their nets with `label[i].`).
* `always` / `always_ff` / `always_comb` / `always_latch` bodies are parsed
  (if/else, case, for, begin/end, blocking and non-blocking assignments,
  local variables) and reduced to their read and write sets. `initial`
  blocks, functions and tasks are skipped.

Parse errors are reported in the editor panel and never stop rendering of the
rest of the file.

## Examples

* **riscv-simple-sv** (default) – the single-cycle, multicycle and 5-stage
  pipeline RV32I cores from
  [tilk/riscv-simple-sv](https://github.com/tilk/riscv-simple-sv)
  (BSD 3-Clause), each assembled into one file by
  `node scripts/import-rvsimple.mjs <checkout>`
  (`src/examples/rvsimple_*.sv`). They exercise the SystemVerilog side of the
  parser: macros and `` `ifdef``, parameterised multiplexers with generate
  loops, `always_ff` pipeline registers over unpacked arrays and a
  behavioural register file.
* **RISC-V SoC** – a small hierarchical RV32I netlist with memories and
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
