import { describe, it, expect } from 'vitest';
import { parseVerilog, exprToString } from '../src/parser/parser';

describe('parser', () => {
  it('parses ANSI module with instances', () => {
    const r = parseVerilog(`
      \`timescale 1ns/1ps
      module top #(parameter W = 8, N = 2) (
        input  wire clk, rst_n,
        input  [W-1:0] a, b,
        output [W-1:0] y,
        output reg done
      );
        wire [W-1:0] s;
        wire c = a[0] & b[0];
        (* keep *) wire k;
        adder #(.W(W)) u_add (.a(a), .b(b), .s(s), .cout());
        buf_cell u_buf[3:0] (s[3:0], y[3:0]);
        assign y[7:4] = {s[7:5], 1'b0};
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) done <= 0; else done <= |s;
        end
      endmodule
      module adder #(parameter W = 4) (a, b, s, cout);
        input [W-1:0] a; input [W-1:0] b;
        output [W-1:0] s; output cout;
        assign {cout, s} = a + b;
      endmodule
    `);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.modules.map((m) => m.name)).toEqual(['top', 'adder']);
    const top = r.modules[0];
    expect(top.ports.map((p) => `${p.dir} ${p.name}`)).toEqual([
      'input clk', 'input rst_n', 'input a', 'input b', 'output y', 'output done',
    ]);
    expect(top.params.map((p) => p.name)).toEqual(['W', 'N']);
    expect(top.instances.length).toBe(2);
    expect(top.instances[0].module).toBe('adder');
    expect(top.instances[0].conns.map((c) => c.port)).toEqual(['a', 'b', 's', 'cout']);
    expect(top.instances[0].conns[3].expr).toBeNull();
    expect(top.instances[1].range).not.toBeNull();
    expect(top.instances[1].positional).toBe(true);
    expect(top.assigns.length).toBe(2); // wire c = ..., assign y[7:4]
    expect(exprToString(top.assigns[1].lhs)).toBe('y[7:4]');
    expect(exprToString(top.assigns[1].rhs)).toBe("{s[7:5], 1'b0}");
    const adder = r.modules[1];
    expect(adder.ports.map((p) => `${p.dir} ${p.name}`)).toEqual(['input a', 'input b', 'output s', 'output cout']);
    expect(adder.ports[0].range).not.toBeNull();
  });

  it('recovers from garbage', () => {
    const r = parseVerilog(`module a(input x, output y); assign y = ; foo bar baz qux; assign y = x; endmodule module b; endmodule`);
    expect(r.modules.map((m) => m.name)).toEqual(['a', 'b']);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.modules[0].assigns.length).toBe(1);
  });

  it('parses expressions', () => {
    const r = parseVerilog(`module e; assign y = a ? {2{b}} : (c[3+:2] ^ ~d) | $signed(e); endmodule`);
    expect(exprToString(r.modules[0].assigns[0].rhs)).toBe("a ? {2{b}} : ((c[3+:2] ^ ~d) | $signed(e))");
  });

  it('handles generate and functions gracefully', () => {
    const r = parseVerilog(`module g(input clk, output [3:0] q);
      genvar i;
      generate for (i=0;i<4;i=i+1) begin : gen
        dff d(.clk(clk), .q(q[i]));
      end endgenerate
      function [3:0] f; input [3:0] x; begin f = x + 1; end endfunction
      inv u0(.a(clk), .y(q[0]));
    endmodule`);
    expect(r.modules[0].instances.map((i) => i.name)).toEqual(['u0']);
  });

  it('parses escaped identifiers and .* connections', () => {
    const r = parseVerilog(`module h(input \\weird[0] , output o); sub s1(.*); sub s2(.a, .b(\\weird[0] )); endmodule`);
    expect(r.modules[0].ports[0].name).toBe('weird[0]');
    expect(r.modules[0].instances[0].conns[0].port).toBe('*');
    expect(exprToString(r.modules[0].instances[1].conns[0].expr!)).toBe('a');
  });
});
