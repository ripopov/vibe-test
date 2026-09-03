import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ELK from 'elkjs/lib/main.js';
import { loadDesign, resolvePath, buildHierarchy } from '../src/model/design';
import { buildGraph } from '../src/model/graph';
import { parseVerilog } from '../src/parser/parser';
import { sizeGraph } from '../src/layout/metrics';
import { graphToElk } from '../src/layout/layout';

const cores = ['singlecycle', 'multicycle', 'pipeline'] as const;
const src = (c: string) => readFileSync(`src/examples/rvsimple_${c}.sv`, 'utf8');

describe('preprocessor', () => {
  it('expands macros and honours ifdef', () => {
    const r = parseVerilog(`
\`define W 8
\`define ZERO {\`W{1'b0}}
\`define ADD(a,b) ((a)+(b))
module m(input [\`W-1:0] a, output [\`W-1:0] y, output [\`W-1:0] z);
\`ifdef NOPE
  assign y = 1;
\`elsif W
  assign y = \`ADD(a, \`W);
\`else
  assign y = 2;
\`endif
\`ifndef NOPE
  assign z = \`ZERO;
\`endif
endmodule`);
    expect(r.diagnostics).toEqual([]);
    const m = r.modules[0];
    expect(m.assigns.length).toBe(2);
    expect(m.assigns[0].rhs.kind).toBe('binary');
    expect(m.assigns[1].rhs.kind).toBe('repl');
    // macro tokens keep the location of the usage
    expect(m.assigns[0].rhs.loc.line).toBe(9);
  });
  it('reports undefined macros', () => {
    const r = parseVerilog('module m; assign a = `FOO; endmodule');
    expect(r.diagnostics.some((d) => d.message.includes('undefined macro'))).toBe(true);
  });
});

describe('procedural blocks', () => {
  it('extracts reads and writes', () => {
    const r = parseVerilog(`module m(input clk, input rst, input [3:0] a, b, output logic [3:0] q, output logic y);
  integer i;
  always_ff @(posedge clk or posedge rst)
    if (rst) q <= 0; else if (a[0]) q <= q + b; else q[1:0] <= b[3:2];
  always_comb begin
    y = 1'b0;
    case (a)
      4'd1, 4'd2: y = b[1];
      default: y = |q;
    endcase
    for (i = 0; i < 4; i = i + 1) if (b[i]) y = 1;
  end
endmodule`);
    expect(r.diagnostics).toEqual([]);
    const [ff, comb] = r.modules[0].procs;
    expect(ff.kind).toBe('always_ff');
    expect(ff.sens?.map((s) => s.edge)).toEqual(['posedge', 'posedge']);
    expect(ff.writes.every((w) => w.nonblocking)).toBe(true);
    expect(comb.kind).toBe('always_comb');
    expect(comb.locals).toEqual(['i']); // loop counter
    expect(r.modules[0].procs.length).toBe(2);
    const d = loadDesign(r.modules.length ? readFileSync('src/examples/rvsimple_singlecycle.sv', 'utf8') : '');
    expect(d.modules.has('alu')).toBe(true);
  });
  it('builds process nodes with data, clock and output pins', () => {
    const d = loadDesign(`module m(input clk, input rst, input [3:0] a, b, output logic [3:0] q, output logic y);
  always_ff @(posedge clk or posedge rst) if (rst) q <= 0; else q <= a + b;
  always_comb y = q[0] ^ a[1];
endmodule`);
    const g = buildGraph(d, 'm');
    const procs = g.nodes.filter((n) => n.kind === 'proc');
    expect(procs.length).toBe(2);
    const ff = procs[0];
    expect(ff.pins.filter((p) => p.side === 'W').map((p) => p.name)).toEqual(['a', 'b', 'clk', 'rst']);
    expect(ff.pins.find((p) => p.name === 'clk')?.clock).toBe('posedge');
    expect(ff.pins.filter((p) => p.side === 'E').map((p) => p.name)).toEqual(['q']);
    const comb = procs[1];
    expect(comb.pins.find((p) => p.name === 'q')?.sliceLabel).toBe('[0]');
    // every pin is wired
    for (const n of procs) for (const p of n.pins) expect(g.edges.some((e) => e.from === p.id || e.to === p.id)).toBe(true);
  });
});

describe('parameters and generate', () => {
  it('sizes instance ports with parameter overrides and unrolls generate loops', () => {
    const d = loadDesign(`
module mux #(parameter WIDTH = 32, parameter CHANNELS = 2) (
  input [(CHANNELS*WIDTH)-1:0] in_bus, input [$clog2(CHANNELS)-1:0] sel, output [WIDTH-1:0] out);
  genvar ig;
  logic [WIDTH-1:0] arr [0:CHANNELS-1];
  assign out = arr[sel];
  for (ig = 0; ig < CHANNELS; ig = ig + 1) begin: g
    assign arr[(CHANNELS-1)-ig] = in_bus[(ig*WIDTH) +: WIDTH];
  end
endmodule
module top(input [63:0] a, input [1:0] s, output [7:0] o);
  mux #(.WIDTH(8), .CHANNELS(4)) u(.in_bus(a[31:0]), .sel(s), .out(o));
endmodule`);
    expect(d.parse.diagnostics).toEqual([]);
    const g = buildGraph(d, 'top');
    const u = g.nodes.find((n) => n.refName === 'u')!;
    expect(u.pins.find((p) => p.name === 'in_bus')?.width).toBe(32);
    expect(u.pins.find((p) => p.name === 'sel')?.width).toBe(2);
    expect(u.tooltip).toContain('WIDTH=8, CHANNELS=4');
    const steps = resolvePath(d, 'top', ['u'])!;
    expect(steps[1].params.get('CHANNELS')).toBe(4);
    const inner = buildGraph(d, 'mux', {}, 'u', steps[1].params);
    // the 4 unrolled assigns alias slices of in_bus into arr[i]; the read of arr[sel] is an expression node
    expect(inner.nets.get('arr')?.elems).toBe(4);
    for (let i = 0; i < 4; i++) expect(inner.nets.get(`arr[${i}]`)?.aliases.length).toBe(1);
    const rd = inner.nodes.find((n) => n.kind === 'expr')!;
    expect(rd.title).toBe('arr[sel]');
    // in_bus port drives the expression node through the array aliases
    const inBus = inner.nodes.find((n) => n.kind === 'port' && n.title === 'in_bus')!;
    const wires = inner.edges.filter((e) => e.from === inBus.pins[0].id && e.to.startsWith(rd.id + '.'));
    expect(wires.length).toBe(1); // 4 slices between the same pins are merged into one wire
    expect(wires[0].width).toBe(32);
    expect(wires[0].headLabel).toBeUndefined();
    expect(wires[0].tooltip.split('\n').length).toBe(4);
    const tree = buildHierarchy(d, 'top');
    expect(tree.children[0].paramText).toBe('WIDTH=8, CHANNELS=4');
  });
});

describe('riscv-simple-sv', () => {
  for (const core of cores) {
    it(`parses the ${core} core without diagnostics`, () => {
      const d = loadDesign(src(core));
      expect(d.parse.diagnostics).toEqual([]);
      expect(d.tops[0]).toBe('toplevel');
      expect(d.blackBoxes.size).toBe(0);
    });
  }
  it('gives every module a connected schematic', { timeout: 120000 }, async () => {
    for (const core of cores) {
      const d = loadDesign(src(core));
      const elk = new ELK();
      for (const name of d.modules.keys()) {
        const g = buildGraph(d, name);
        // no dangling pins on process nodes / instances except genuinely unconnected ports
        for (const n of g.nodes) {
          if (n.kind !== 'proc') continue;
          for (const p of n.pins) expect(p.connected || p.netLabel || p.constLabel, `${core}/${name}: ${n.title} pin ${p.name}`).toBeTruthy();
        }
        sizeGraph(g, { showTypes: true });
        const res = (await elk.layout(graphToElk(g, { showTypes: true, spacing: 1, thoroughness: 7, netNames: false, freePinOrder: true }) as never)) as unknown as { width: number };
        process.stderr.write(`${core.padEnd(12)} ${name.padEnd(24)} ${g.nodes.length} nodes ${g.edges.length} edges\n`);
        if (g.edges.length) expect(res.width).toBeGreaterThan(0);
      }
    }
  });
  it('models the pipeline registers', () => {
    const d = loadDesign(src('pipeline'));
    const g = buildGraph(d, 'pipeline_datapath');
    const procs = g.nodes.filter((n) => n.kind === 'proc');
    expect(procs.length).toBe(4);
    // inst[PL_ID] <= inst[PL_IF]: element nets of the unpacked array
    expect(g.nets.get('inst[0]')?.width).toBe(32);
    expect(g.nets.get('inst[1]')?.drivers.length).toBe(1);
    const stage1 = procs[0];
    expect(stage1.pins.some((p) => p.name === 'inst[0]' && p.side === 'W')).toBe(true);
    expect(stage1.pins.some((p) => p.name === 'inst[1]' && p.side === 'E')).toBe(true);
    // the memory read in regfile is an expression node fed by the array written in the process
    const rf = buildGraph(d, 'regfile');
    const proc = rf.nodes.find((n) => n.kind === 'proc')!;
    const out = proc.pins.find((p) => p.side === 'E')!;
    expect(out.name).toBe('register');
    expect(out.widthLabel).toBe('32×32');
    expect(rf.edges.filter((e) => e.from === out.id).length).toBe(2);
  });
});
