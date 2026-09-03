// ---------------------------------------------------------------------------
//  Tiny RISC-V (RV32I) core hierarchy - showcase design for the schematic
//  viewer. Structure only: the leaf modules contain behavioural code that the
//  viewer skips, everything else is ports, wires, assigns and instances.
// ---------------------------------------------------------------------------
`timescale 1ns/1ps

module riscv_soc (
  input  wire        clk,
  input  wire        rst_n,
  input  wire        uart_rx,
  output wire        uart_tx,
  input  wire [7:0]  gpio_in,
  output wire [7:0]  gpio_out,
  output wire        irq_ack
);
  // instruction memory bus
  wire [31:0] imem_addr;
  wire [31:0] imem_rdata;
  // data memory bus
  wire [31:0] dmem_addr;
  wire [31:0] dmem_wdata;
  wire [31:0] dmem_rdata;
  wire        dmem_we;
  wire [3:0]  dmem_be;
  wire        dmem_req;
  // peripheral bus
  wire        periph_sel;
  wire        mem_sel;
  wire [31:0] periph_rdata;
  wire [31:0] mem_rdata;
  wire        timer_irq;
  wire        uart_irq;

  assign mem_sel    = ~dmem_addr[31];
  assign periph_sel = dmem_addr[31];
  assign dmem_rdata = periph_sel ? periph_rdata : mem_rdata;

  riscv_core u_core (
    .clk        (clk),
    .rst_n      (rst_n),
    .imem_addr  (imem_addr),
    .imem_rdata (imem_rdata),
    .dmem_addr  (dmem_addr),
    .dmem_wdata (dmem_wdata),
    .dmem_rdata (dmem_rdata),
    .dmem_we    (dmem_we),
    .dmem_be    (dmem_be),
    .dmem_req   (dmem_req),
    .irq        (timer_irq | uart_irq),
    .irq_ack    (irq_ack)
  );

  rom #(.DEPTH(1024)) u_imem (
    .clk   (clk),
    .addr  (imem_addr[11:2]),
    .rdata (imem_rdata)
  );

  ram #(.DEPTH(4096)) u_dmem (
    .clk   (clk),
    .en    (dmem_req & mem_sel),
    .we    (dmem_we),
    .be    (dmem_be),
    .addr  (dmem_addr[13:2]),
    .wdata (dmem_wdata),
    .rdata (mem_rdata)
  );

  periph_bus u_periph (
    .clk       (clk),
    .rst_n     (rst_n),
    .sel       (dmem_req & periph_sel),
    .we        (dmem_we),
    .addr      (dmem_addr[7:0]),
    .wdata     (dmem_wdata),
    .rdata     (periph_rdata),
    .uart_rx   (uart_rx),
    .uart_tx   (uart_tx),
    .gpio_in   (gpio_in),
    .gpio_out  (gpio_out),
    .timer_irq (timer_irq),
    .uart_irq  (uart_irq)
  );
endmodule

// ---------------------------------------------------------------------------
module riscv_core (
  input  wire        clk,
  input  wire        rst_n,
  output wire [31:0] imem_addr,
  input  wire [31:0] imem_rdata,
  output wire [31:0] dmem_addr,
  output wire [31:0] dmem_wdata,
  input  wire [31:0] dmem_rdata,
  output wire        dmem_we,
  output wire [3:0]  dmem_be,
  output wire        dmem_req,
  input  wire        irq,
  output wire        irq_ack
);
  wire [31:0] pc;
  wire [31:0] pc_plus4;
  wire [31:0] pc_next;
  wire [31:0] instr;
  wire [31:0] imm;
  wire [4:0]  rs1_addr, rs2_addr, rd_addr;
  wire [31:0] rs1_data, rs2_data;
  wire [31:0] alu_a, alu_b, alu_result;
  wire [3:0]  alu_op;
  wire        alu_zero;
  wire        alu_lt;
  wire        branch_taken;
  wire        branch, jump, jalr;
  wire        alu_src_a, alu_src_b;
  wire        mem_read, mem_write, mem_to_reg;
  wire        reg_write;
  wire [1:0]  wb_sel;
  wire [2:0]  funct3;
  wire [31:0] load_data;
  wire [31:0] wb_data;
  wire        stall;
  wire        trap;

  assign instr     = imem_rdata;
  assign imem_addr = pc;
  assign dmem_addr = alu_result;
  assign dmem_req  = mem_read | mem_write;
  assign dmem_we   = mem_write & ~stall;

  pc_unit u_pc (
    .clk          (clk),
    .rst_n        (rst_n),
    .stall        (stall),
    .branch_taken (branch_taken),
    .jump         (jump),
    .jalr         (jalr),
    .imm          (imm),
    .rs1_data     (rs1_data),
    .pc           (pc),
    .pc_plus4     (pc_plus4),
    .pc_next      (pc_next)
  );

  decoder u_dec (
    .instr      (instr),
    .rs1_addr   (rs1_addr),
    .rs2_addr   (rs2_addr),
    .rd_addr    (rd_addr),
    .funct3     (funct3),
    .alu_op     (alu_op),
    .alu_src_a  (alu_src_a),
    .alu_src_b  (alu_src_b),
    .branch     (branch),
    .jump       (jump),
    .jalr       (jalr),
    .mem_read   (mem_read),
    .mem_write  (mem_write),
    .mem_to_reg (mem_to_reg),
    .reg_write  (reg_write),
    .wb_sel     (wb_sel),
    .trap       (trap)
  );

  imm_gen u_imm (
    .instr (instr),
    .imm   (imm)
  );

  regfile u_rf (
    .clk      (clk),
    .rst_n    (rst_n),
    .we       (reg_write & ~stall),
    .rs1_addr (rs1_addr),
    .rs2_addr (rs2_addr),
    .rd_addr  (rd_addr),
    .rd_data  (wb_data),
    .rs1_data (rs1_data),
    .rs2_data (rs2_data)
  );

  assign alu_a = alu_src_a ? pc  : rs1_data;
  assign alu_b = alu_src_b ? imm : rs2_data;

  alu u_alu (
    .a      (alu_a),
    .b      (alu_b),
    .op     (alu_op),
    .result (alu_result),
    .zero   (alu_zero),
    .lt     (alu_lt)
  );

  branch_unit u_bru (
    .branch   (branch),
    .funct3   (funct3),
    .zero     (alu_zero),
    .lt       (alu_lt),
    .rs1_data (rs1_data),
    .rs2_data (rs2_data),
    .taken    (branch_taken)
  );

  lsu u_lsu (
    .clk        (clk),
    .rst_n      (rst_n),
    .funct3     (funct3),
    .addr_lo    (alu_result[1:0]),
    .store_data (rs2_data),
    .mem_read   (mem_read),
    .mem_write  (mem_write),
    .wdata      (dmem_wdata),
    .be         (dmem_be),
    .rdata      (dmem_rdata),
    .load_data  (load_data),
    .stall      (stall)
  );

  wb_mux u_wb (
    .sel        (wb_sel),
    .mem_to_reg (mem_to_reg),
    .alu_result (alu_result),
    .load_data  (load_data),
    .pc_plus4   (pc_plus4),
    .imm        (imm),
    .wb_data    (wb_data)
  );

  irq_ctrl u_irq (
    .clk     (clk),
    .rst_n   (rst_n),
    .irq     (irq),
    .trap    (trap),
    .pc      (pc),
    .irq_ack (irq_ack)
  );
endmodule

// ---------------------------------------------------------------------------
module pc_unit (
  input  wire        clk,
  input  wire        rst_n,
  input  wire        stall,
  input  wire        branch_taken,
  input  wire        jump,
  input  wire        jalr,
  input  wire [31:0] imm,
  input  wire [31:0] rs1_data,
  output wire [31:0] pc,
  output wire [31:0] pc_plus4,
  output wire [31:0] pc_next
);
  wire [31:0] pc_q;
  wire [31:0] target;
  wire [31:0] base;
  wire        redirect;

  assign pc       = pc_q;
  assign pc_plus4 = pc_q + 32'd4;
  assign base     = jalr ? rs1_data : pc_q;
  assign target   = (base + imm) & ~32'd1;
  assign redirect = branch_taken | jump | jalr;
  assign pc_next  = redirect ? target : pc_plus4;

  dff_en #(.W(32), .RESET_VAL(32'h0000_0000)) u_pc_reg (
    .clk   (clk),
    .rst_n (rst_n),
    .en    (~stall),
    .d     (pc_next),
    .q     (pc_q)
  );
endmodule

// ---------------------------------------------------------------------------
module decoder (
  input  wire [31:0] instr,
  output wire [4:0]  rs1_addr,
  output wire [4:0]  rs2_addr,
  output wire [4:0]  rd_addr,
  output wire [2:0]  funct3,
  output wire [3:0]  alu_op,
  output wire        alu_src_a,
  output wire        alu_src_b,
  output wire        branch,
  output wire        jump,
  output wire        jalr,
  output wire        mem_read,
  output wire        mem_write,
  output wire        mem_to_reg,
  output wire        reg_write,
  output wire [1:0]  wb_sel,
  output wire        trap
);
  wire [6:0] opcode;
  wire [6:0] funct7;

  assign opcode   = instr[6:0];
  assign rd_addr  = instr[11:7];
  assign funct3   = instr[14:12];
  assign rs1_addr = instr[19:15];
  assign rs2_addr = instr[24:20];
  assign funct7   = instr[31:25];

  control_rom u_ctrl (
    .opcode     (opcode),
    .funct3     (funct3),
    .funct7_5   (funct7[5]),
    .alu_op     (alu_op),
    .alu_src_a  (alu_src_a),
    .alu_src_b  (alu_src_b),
    .branch     (branch),
    .jump       (jump),
    .jalr       (jalr),
    .mem_read   (mem_read),
    .mem_write  (mem_write),
    .mem_to_reg (mem_to_reg),
    .reg_write  (reg_write),
    .wb_sel     (wb_sel),
    .trap       (trap)
  );
endmodule

module control_rom (
  input  wire [6:0] opcode,
  input  wire [2:0] funct3,
  input  wire       funct7_5,
  output reg  [3:0] alu_op,
  output reg        alu_src_a,
  output reg        alu_src_b,
  output reg        branch,
  output reg        jump,
  output reg        jalr,
  output reg        mem_read,
  output reg        mem_write,
  output reg        mem_to_reg,
  output reg        reg_write,
  output reg  [1:0] wb_sel,
  output reg        trap
);
  always @* begin
    {alu_op, alu_src_a, alu_src_b, branch, jump, jalr} = 0;
    {mem_read, mem_write, mem_to_reg, reg_write, wb_sel, trap} = 0;
    case (opcode)
      7'b0110011: begin reg_write = 1; alu_op = {funct7_5, funct3}; end
      7'b0010011: begin reg_write = 1; alu_src_b = 1; alu_op = {1'b0, funct3}; end
      7'b0000011: begin reg_write = 1; alu_src_b = 1; mem_read = 1; mem_to_reg = 1; end
      7'b0100011: begin alu_src_b = 1; mem_write = 1; end
      7'b1100011: begin branch = 1; end
      7'b1101111: begin reg_write = 1; jump = 1; wb_sel = 2'd1; end
      7'b1100111: begin reg_write = 1; jalr = 1; wb_sel = 2'd1; end
      7'b0110111: begin reg_write = 1; wb_sel = 2'd2; end
      7'b0010111: begin reg_write = 1; alu_src_a = 1; alu_src_b = 1; end
      default:    trap = 1;
    endcase
  end
endmodule

// ---------------------------------------------------------------------------
module imm_gen (
  input  wire [31:0] instr,
  output wire [31:0] imm
);
  wire [6:0]  opcode = instr[6:0];
  wire [31:0] imm_i, imm_s, imm_b, imm_u, imm_j;
  wire        is_s, is_b, is_u, is_j;

  assign imm_i = {{20{instr[31]}}, instr[31:20]};
  assign imm_s = {{20{instr[31]}}, instr[31:25], instr[11:7]};
  assign imm_b = {{19{instr[31]}}, instr[31], instr[7], instr[30:25], instr[11:8], 1'b0};
  assign imm_u = {instr[31:12], 12'b0};
  assign imm_j = {{11{instr[31]}}, instr[31], instr[19:12], instr[20], instr[30:21], 1'b0};

  assign is_s = opcode == 7'b0100011;
  assign is_b = opcode == 7'b1100011;
  assign is_u = (opcode == 7'b0110111) | (opcode == 7'b0010111);
  assign is_j = opcode == 7'b1101111;

  assign imm = is_s ? imm_s :
               is_b ? imm_b :
               is_u ? imm_u :
               is_j ? imm_j : imm_i;
endmodule

// ---------------------------------------------------------------------------
module regfile (
  input  wire        clk,
  input  wire        rst_n,
  input  wire        we,
  input  wire [4:0]  rs1_addr,
  input  wire [4:0]  rs2_addr,
  input  wire [4:0]  rd_addr,
  input  wire [31:0] rd_data,
  output wire [31:0] rs1_data,
  output wire [31:0] rs2_data
);
  reg [31:0] regs [31:0];
  integer i;
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      for (i = 0; i < 32; i = i + 1) regs[i] <= 32'd0;
    end else if (we && rd_addr != 5'd0) begin
      regs[rd_addr] <= rd_data;
    end
  end
  assign rs1_data = (rs1_addr == 5'd0) ? 32'd0 : regs[rs1_addr];
  assign rs2_data = (rs2_addr == 5'd0) ? 32'd0 : regs[rs2_addr];
endmodule

// ---------------------------------------------------------------------------
module alu (
  input  wire [31:0] a,
  input  wire [31:0] b,
  input  wire [3:0]  op,
  output wire [31:0] result,
  output wire        zero,
  output wire        lt
);
  wire [31:0] sum, diff, shl, shr, sra, logic_r;
  wire [4:0]  shamt;
  wire        slt, sltu;

  assign shamt   = b[4:0];
  assign sum     = a + b;
  assign diff    = a - b;
  assign slt     = ($signed(a) < $signed(b));
  assign sltu    = (a < b);
  assign shl     = a << shamt;
  assign shr     = a >> shamt;
  assign sra     = $signed(a) >>> shamt;

  alu_logic u_logic (
    .a   (a),
    .b   (b),
    .op  (op[1:0]),
    .y   (logic_r)
  );

  alu_result_mux u_mux (
    .op     (op),
    .sum    (sum),
    .diff   (diff),
    .shl    (shl),
    .shr    (shr),
    .sra    (sra),
    .slt    ({31'd0, slt}),
    .sltu   ({31'd0, sltu}),
    .logic_r(logic_r),
    .result (result)
  );

  assign zero = (result == 32'd0);
  assign lt   = op[0] ? sltu : slt;
endmodule

module alu_logic (
  input  wire [31:0] a,
  input  wire [31:0] b,
  input  wire [1:0]  op,
  output wire [31:0] y
);
  wire [31:0] x_and = a & b;
  wire [31:0] x_or  = a | b;
  wire [31:0] x_xor = a ^ b;
  assign y = op[1] ? (op[0] ? x_and : x_or) : x_xor;
endmodule

module alu_result_mux (
  input  wire [3:0]  op,
  input  wire [31:0] sum, diff, shl, shr, sra, slt, sltu, logic_r,
  output reg  [31:0] result
);
  always @* begin
    case (op)
      4'b0000: result = sum;
      4'b1000: result = diff;
      4'b0001: result = shl;
      4'b0010: result = slt;
      4'b0011: result = sltu;
      4'b0101: result = shr;
      4'b1101: result = sra;
      default: result = logic_r;
    endcase
  end
endmodule

// ---------------------------------------------------------------------------
module branch_unit (
  input  wire        branch,
  input  wire [2:0]  funct3,
  input  wire        zero,
  input  wire        lt,
  input  wire [31:0] rs1_data,
  input  wire [31:0] rs2_data,
  output wire        taken
);
  wire eq  = (rs1_data == rs2_data);
  wire ltu = (rs1_data < rs2_data);
  wire cond;
  assign cond = (funct3 == 3'b000) ?  eq  :
                (funct3 == 3'b001) ? ~eq  :
                (funct3 == 3'b100) ?  lt  :
                (funct3 == 3'b101) ? ~lt  :
                (funct3 == 3'b110) ?  ltu : ~ltu;
  assign taken = branch & cond;
endmodule

// ---------------------------------------------------------------------------
module lsu (
  input  wire        clk,
  input  wire        rst_n,
  input  wire [2:0]  funct3,
  input  wire [1:0]  addr_lo,
  input  wire [31:0] store_data,
  input  wire        mem_read,
  input  wire        mem_write,
  output wire [31:0] wdata,
  output wire [3:0]  be,
  input  wire [31:0] rdata,
  output wire [31:0] load_data,
  output wire        stall
);
  wire [31:0] shifted;
  wire        pending;

  store_align u_st (
    .funct3  (funct3),
    .addr_lo (addr_lo),
    .data    (store_data),
    .wdata   (wdata),
    .be      (be)
  );

  assign shifted = rdata >> {addr_lo, 3'b000};

  load_extend u_ld (
    .funct3 (funct3),
    .data   (shifted),
    .q      (load_data)
  );

  dff_en #(.W(1)) u_pending (
    .clk   (clk),
    .rst_n (rst_n),
    .en    (1'b1),
    .d     (mem_read & ~pending),
    .q     (pending)
  );
  assign stall = mem_read & ~pending;
endmodule

module store_align (
  input  wire [2:0]  funct3,
  input  wire [1:0]  addr_lo,
  input  wire [31:0] data,
  output reg  [31:0] wdata,
  output reg  [3:0]  be
);
  always @* begin
    case (funct3[1:0])
      2'b00: begin wdata = {4{data[7:0]}};  be = 4'b0001 << addr_lo; end
      2'b01: begin wdata = {2{data[15:0]}}; be = addr_lo[1] ? 4'b1100 : 4'b0011; end
      default: begin wdata = data; be = 4'b1111; end
    endcase
  end
endmodule

module load_extend (
  input  wire [2:0]  funct3,
  input  wire [31:0] data,
  output reg  [31:0] q
);
  always @* begin
    case (funct3)
      3'b000: q = {{24{data[7]}},  data[7:0]};
      3'b001: q = {{16{data[15]}}, data[15:0]};
      3'b100: q = {24'd0, data[7:0]};
      3'b101: q = {16'd0, data[15:0]};
      default: q = data;
    endcase
  end
endmodule

// ---------------------------------------------------------------------------
module wb_mux (
  input  wire [1:0]  sel,
  input  wire        mem_to_reg,
  input  wire [31:0] alu_result,
  input  wire [31:0] load_data,
  input  wire [31:0] pc_plus4,
  input  wire [31:0] imm,
  output wire [31:0] wb_data
);
  wire [31:0] alu_or_mem = mem_to_reg ? load_data : alu_result;
  assign wb_data = (sel == 2'd1) ? pc_plus4 :
                   (sel == 2'd2) ? imm : alu_or_mem;
endmodule

// ---------------------------------------------------------------------------
module irq_ctrl (
  input  wire        clk,
  input  wire        rst_n,
  input  wire        irq,
  input  wire        trap,
  input  wire [31:0] pc,
  output wire        irq_ack
);
  wire irq_q, irq_d;
  assign irq_d   = irq & ~trap;
  assign irq_ack = irq_q & ~irq;
  dff_en #(.W(1)) u_irq_q (
    .clk   (clk),
    .rst_n (rst_n),
    .en    (1'b1),
    .d     (irq_d),
    .q     (irq_q)
  );
endmodule

// ---------------------------------------------------------------------------
module dff_en #(
  parameter W = 1,
  parameter RESET_VAL = 0
) (
  input  wire         clk,
  input  wire         rst_n,
  input  wire         en,
  input  wire [W-1:0] d,
  output reg  [W-1:0] q
);
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) q <= RESET_VAL;
    else if (en) q <= d;
  end
endmodule

module rom #(parameter DEPTH = 1024) (
  input  wire                      clk,
  input  wire [$clog2(DEPTH)-1:0]  addr,
  output reg  [31:0]               rdata
);
  reg [31:0] mem [0:DEPTH-1];
  always @(posedge clk) rdata <= mem[addr];
endmodule

module ram #(parameter DEPTH = 4096) (
  input  wire                      clk,
  input  wire                      en,
  input  wire                      we,
  input  wire [3:0]                be,
  input  wire [$clog2(DEPTH)-1:0]  addr,
  input  wire [31:0]               wdata,
  output reg  [31:0]               rdata
);
  reg [31:0] mem [0:DEPTH-1];
  always @(posedge clk) begin
    if (en & we) begin
      if (be[0]) mem[addr][7:0]   <= wdata[7:0];
      if (be[1]) mem[addr][15:8]  <= wdata[15:8];
      if (be[2]) mem[addr][23:16] <= wdata[23:16];
      if (be[3]) mem[addr][31:24] <= wdata[31:24];
    end
    if (en) rdata <= mem[addr];
  end
endmodule

// ---------------------------------------------------------------------------
module periph_bus (
  input  wire        clk,
  input  wire        rst_n,
  input  wire        sel,
  input  wire        we,
  input  wire [7:0]  addr,
  input  wire [31:0] wdata,
  output wire [31:0] rdata,
  input  wire        uart_rx,
  output wire        uart_tx,
  input  wire [7:0]  gpio_in,
  output wire [7:0]  gpio_out,
  output wire        timer_irq,
  output wire        uart_irq
);
  wire        uart_sel  = sel & (addr[7:4] == 4'h0);
  wire        gpio_sel  = sel & (addr[7:4] == 4'h1);
  wire        timer_sel = sel & (addr[7:4] == 4'h2);
  wire [31:0] uart_rdata, gpio_rdata, timer_rdata;

  uart u_uart (
    .clk   (clk),
    .rst_n (rst_n),
    .sel   (uart_sel),
    .we    (we),
    .addr  (addr[3:2]),
    .wdata (wdata[7:0]),
    .rdata (uart_rdata),
    .rx    (uart_rx),
    .tx    (uart_tx),
    .irq   (uart_irq)
  );

  gpio u_gpio (
    .clk      (clk),
    .rst_n    (rst_n),
    .sel      (gpio_sel),
    .we       (we),
    .wdata    (wdata[7:0]),
    .rdata    (gpio_rdata),
    .gpio_in  (gpio_in),
    .gpio_out (gpio_out)
  );

  timer u_timer (
    .clk   (clk),
    .rst_n (rst_n),
    .sel   (timer_sel),
    .we    (we),
    .addr  (addr[3:2]),
    .wdata (wdata),
    .rdata (timer_rdata),
    .irq   (timer_irq)
  );

  assign rdata = uart_sel  ? uart_rdata  :
                 gpio_sel  ? gpio_rdata  :
                 timer_sel ? timer_rdata : 32'hDEAD_BEEF;
endmodule

module uart (
  input  wire        clk,
  input  wire        rst_n,
  input  wire        sel,
  input  wire        we,
  input  wire [1:0]  addr,
  input  wire [7:0]  wdata,
  output wire [31:0] rdata,
  input  wire        rx,
  output wire        tx,
  output wire        irq
);
  wire [7:0] rx_data;
  wire       rx_valid, tx_busy;
  wire       tx_start = sel & we & (addr == 2'd0);
  uart_tx u_tx (.clk(clk), .rst_n(rst_n), .start(tx_start), .data(wdata), .tx(tx), .busy(tx_busy));
  uart_rx u_rx (.clk(clk), .rst_n(rst_n), .rx(rx), .data(rx_data), .valid(rx_valid));
  assign rdata = {22'd0, tx_busy, rx_valid, rx_data};
  assign irq   = rx_valid;
endmodule

module uart_tx (input clk, input rst_n, input start, input [7:0] data, output reg tx, output reg busy);
  reg [3:0] cnt;
  reg [9:0] shift;
  always @(posedge clk or negedge rst_n)
    if (!rst_n) begin tx <= 1'b1; busy <= 1'b0; cnt <= 0; shift <= 10'h3FF; end
    else if (start && !busy) begin busy <= 1'b1; shift <= {1'b1, data, 1'b0}; cnt <= 4'd10; end
    else if (busy) begin tx <= shift[0]; shift <= {1'b1, shift[9:1]}; cnt <= cnt - 1; if (cnt == 1) busy <= 1'b0; end
endmodule

module uart_rx (input clk, input rst_n, input rx, output reg [7:0] data, output reg valid);
  reg [3:0] cnt;
  always @(posedge clk or negedge rst_n)
    if (!rst_n) begin data <= 0; valid <= 0; cnt <= 0; end
    else begin valid <= (cnt == 4'd9); if (!rx || cnt != 0) begin cnt <= cnt + 1; data <= {rx, data[7:1]}; end end
endmodule

module gpio (
  input  wire        clk,
  input  wire        rst_n,
  input  wire        sel,
  input  wire        we,
  input  wire [7:0]  wdata,
  output wire [31:0] rdata,
  input  wire [7:0]  gpio_in,
  output wire [7:0]  gpio_out
);
  wire [7:0] out_q;
  dff_en #(.W(8)) u_out (.clk(clk), .rst_n(rst_n), .en(sel & we), .d(wdata), .q(out_q));
  assign gpio_out = out_q;
  assign rdata    = {16'd0, out_q, gpio_in};
endmodule

module timer (
  input  wire        clk,
  input  wire        rst_n,
  input  wire        sel,
  input  wire        we,
  input  wire [1:0]  addr,
  input  wire [31:0] wdata,
  output wire [31:0] rdata,
  output wire        irq
);
  wire [31:0] count, compare;
  wire        wr_cmp = sel & we & (addr == 2'd1);
  dff_en #(.W(32)) u_count (.clk(clk), .rst_n(rst_n), .en(1'b1),   .d(count + 32'd1), .q(count));
  dff_en #(.W(32), .RESET_VAL(32'hFFFF_FFFF)) u_cmp (.clk(clk), .rst_n(rst_n), .en(wr_cmp), .d(wdata), .q(compare));
  assign irq   = (count == compare);
  assign rdata = addr[0] ? compare : count;
endmodule
