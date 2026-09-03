// RISC-V SiMPLE SV -- singlecycle core, assembled into one file for the schematic viewer.
// Source: https://github.com/tilk/riscv-simple-sv (BSD 3-Clause License)
// (c) 2017-2021, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław
//
// Files are concatenated in this order: synth/config.sv, core/common/constants.sv,
// core/singlecycle/*.sv, core/common/*.sv. The `include lines of the original files were removed
// because the configuration and constants are inlined below.

// ======== synth/config.sv ========
// RISC-V SiMPLE SV -- common configuration for testbench
// BSD 3-Clause License
// (c) 2017-2021, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

`ifndef RV_CONFIG
`define RV_CONFIG

// Select ISA extensions
// `define M_MODULE    // multiplication and division

//////////////////////////////////////////
//              Memory config           //
//////////////////////////////////////////

// Program counter initial value
`define INITIAL_PC      32'h00400000

// Instruction memory
`define TEXT_BEGIN      `INITIAL_PC
`define TEXT_BITS       16
`define TEXT_WIDTH      2**`TEXT_BITS
`define TEXT_END        `TEXT_BEGIN + `TEXT_WIDTH - 1

// Data memory
`define DATA_BEGIN      32'h8000_0000
`define DATA_BITS       17
`define DATA_WIDTH      2**`DATA_BITS
`define DATA_END        `DATA_BEGIN + `DATA_WIDTH - 1

`define TEXT_HEX        "add.text.vh"
`define DATA_HEX        "add.data.vh"

`endif

// ======== core/common/constants.sv ========
// RISC-V SiMPLE SV -- constants
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

`ifndef RV_CONSTANTS
`define RV_CONSTANTS

//////////////////////////////////////////
//              Constants               //
//////////////////////////////////////////

`define ON              1'b1
`define OFF             1'b0
`define ZERO            32'b0

// Instruction opcodes
`define OPCODE_LOAD     7'b0000011
`define OPCODE_LOAD_FP  7'b0000111
`define OPCODE_MISC_MEM 7'b0001111
`define OPCODE_OP_IMM   7'b0010011
`define OPCODE_AUIPC    7'b0010111
`define OPCODE_STORE    7'b0100011
`define OPCODE_STORE_FP 7'b0100111
`define OPCODE_OP       7'b0110011
`define OPCODE_LUI      7'b0110111
`define OPCODE_OP_FP    7'b1010011
`define OPCODE_BRANCH   7'b1100011
`define OPCODE_JALR     7'b1100111
`define OPCODE_JAL      7'b1101111
`define OPCODE_SYSTEM   7'b1110011

// Interpretations of the "funct3" field
`define FUNCT3_ALU_ADD_SUB  3'b000
`define FUNCT3_ALU_SLL      3'b001
`define FUNCT3_ALU_SLT      3'b010
`define FUNCT3_ALU_SLTU     3'b011
`define FUNCT3_ALU_XOR      3'b100
`define FUNCT3_ALU_SHIFTR   3'b101
`define FUNCT3_ALU_OR       3'b110
`define FUNCT3_ALU_AND      3'b111

// Interpretations of the "funct3" field for extension M
`define FUNCT3_ALU_MUL      3'b000
`define FUNCT3_ALU_MULH     3'b001
`define FUNCT3_ALU_MULHSU   3'b010
`define FUNCT3_ALU_MULHU    3'b011
`define FUNCT3_ALU_DIV      3'b100
`define FUNCT3_ALU_DIVU     3'b101
`define FUNCT3_ALU_REM      3'b110
`define FUNCT3_ALU_REMU     3'b111

// Interpretations of the "funct7" field for extension F
`define FUNCT7_FPALU_ADD    7'b0000000
`define FUNCT7_FPALU_SUB    7'b0000100
`define FUNCT7_FPALU_MUL    7'b0001000
`define FUNCT7_FPALU_DIV    7'b0001100
`define FUNCT7_FPALU_SQRT   7'b0101100
`define FUNCT7_FPALU_SIGN   7'b0010000
`define FUNCT7_FPALU_MINMAX 7'b0010100
`define FUNCT7_FPALU_CVT_W  7'b1100000
`define FUNCT7_FPALU_MV_X   7'b1110000
`define FUNCT7_FPALU_COMP   7'b1010000
`define FUNCT7_FPALU_CLASS  7'b1110000
`define FUNCT7_FPALU_CVT_S  7'b1101000
`define FUNCT7_FPALU_MV_W   7'b1111000

// Interpretations of the "funct3" field for extension F (rounding modes)
`define FUNCT3_ROUND_RNE    3'b000
`define FUNCT3_ROUND_RTZ    3'b001
`define FUNCT3_ROUND_RDN    3'b010
`define FUNCT3_ROUND_RUP    3'b011
`define FUNCT3_ROUND_RMM    3'b100
`define FUNCT3_ROUND_DYN    3'b111

// Interpretations of the "funct3" field for loads and stores
`define FUNCT3_MEM_BYTE     3'b000
`define FUNCT3_MEM_HALF     3'b001
`define FUNCT3_MEM_WORD     3'b010
`define FUNCT3_MEM_BYTE_U   3'b100
`define FUNCT3_MEM_HALF_U   3'b101

// Interpretations of the "funct3" field for branches
`define FUNCT3_BRANCH_EQ    3'b000
`define FUNCT3_BRANCH_NE    3'b001
`define FUNCT3_BRANCH_LT    3'b100
`define FUNCT3_BRANCH_GE    3'b101
`define FUNCT3_BRANCH_LTU   3'b110
`define FUNCT3_BRANCH_GEU   3'b111

// Interpretations of the "funct3" field for system opcode
`define FUNCT3_SYSTEM_ENV       3'b000
`define FUNCT3_SYSTEM_CSRRW     3'b001
`define FUNCT3_SYSTEM_CSRRS     3'b010
`define FUNCT3_SYSTEM_CSRRC     3'b011
`define FUNCT3_SYSTEM_CSRRWI    3'b101
`define FUNCT3_SYSTEM_CSRRSS    3'b110
`define FUNCT3_SYSTEM_CSRRCI    3'b111

// ALU operations
`define ALU_ADD     5'b00001
`define ALU_SUB     5'b00010
`define ALU_SLL     5'b00011
`define ALU_SRL     5'b00100
`define ALU_SRA     5'b00101
`define ALU_SEQ     5'b00110
`define ALU_SLT     5'b00111
`define ALU_SLTU    5'b01000
`define ALU_XOR     5'b01001
`define ALU_OR      5'b01010
`define ALU_AND     5'b01011
`define ALU_MUL     5'b01100
`define ALU_MULH    5'b01101
`define ALU_MULHSU  5'b01110
`define ALU_MULHU   5'b01111
`define ALU_DIV     5'b10000
`define ALU_DIVU    5'b10001
`define ALU_REM     5'b10010
`define ALU_REMU    5'b10011

// ALU op types
`define CTL_ALU_ADD    2'b00
`define CTL_ALU_BRANCH 2'b01
`define CTL_ALU_OP     2'b10
`define CTL_ALU_OP_IMM 2'b11

// Register data sources
`define CTL_WRITEBACK_ALU   3'b000
`define CTL_WRITEBACK_DATA  3'b001
`define CTL_WRITEBACK_PC4   3'b010
`define CTL_WRITEBACK_IMM   3'b011

// ALU 1st operand source
`define CTL_ALU_A_RS1   1'b0
`define CTL_ALU_A_PC    1'b1

// ALU 2nd operand source
`define CTL_ALU_B_RS2   1'b0
`define CTL_ALU_B_IMM   1'b1

// PC source
`define CTL_PC_PC4      2'b00
`define CTL_PC_PC_IMM   2'b01
`define CTL_PC_RS1_IMM  2'b10
`define CTL_PC_PC4_BR   2'b11

// PC source in multicycle
`define MC_CTL_PC_ALU_RES   1'b0
`define MC_CTL_PC_ALU_OUT   1'b1

// ALU 2nd operand source in multicycle
`define MC_CTL_ALU_B_RS2    2'b00
`define MC_CTL_ALU_B_IMM    2'b01
`define MC_CTL_ALU_B_4      2'b10

`endif


// ======== core/singlecycle/toplevel.sv ========
// RISC-V SiMPLE SV -- Toplevel
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module toplevel (
    input  clock,
    input  reset,

    output [31:0] bus_read_data,
    output [31:0] bus_address,
    output [31:0] bus_write_data,
    output [3:0]  bus_byte_enable,
    output        bus_read_enable,
    output        bus_write_enable,

    output [31:0] inst,
    output [31:0] pc
);

    riscv_core riscv_core (
        .clock                  (clock),
        .reset                  (reset),
        .inst                   (inst),
        .pc                     (pc),
        .bus_address            (bus_address),
        .bus_read_data          (bus_read_data),
        .bus_write_data         (bus_write_data),
        .bus_read_enable        (bus_read_enable),
        .bus_write_enable       (bus_write_enable),
        .bus_byte_enable        (bus_byte_enable)
    );

    example_text_memory_bus text_memory_bus (
        .clock                  (clock),
        .address                (pc),
        .read_data              (inst)
    );
    
    example_data_memory_bus data_memory_bus (
        .clock                  (clock),
        .address                (bus_address),
        .read_data              (bus_read_data),
        .write_data             (bus_write_data),
        .read_enable            (bus_read_enable),
        .write_enable           (bus_write_enable),
        .byte_enable            (bus_byte_enable)
    );
    
endmodule


// ======== core/singlecycle/riscv_core.sv ========
// RISC-V SiMPLE SV -- Single-cycle RISC-V core
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module riscv_core (
    input  clock,
    input  reset,

    output [31:0] bus_address,
    input  [31:0] bus_read_data,
    output [31:0] bus_write_data,
    output [3:0]  bus_byte_enable,
    output        bus_read_enable,
    output        bus_write_enable,

    input  [31:0] inst,
    output [31:0] pc
);

    logic pc_write_enable;
    logic regfile_write_enable;
    logic alu_operand_a_select;
    logic alu_operand_b_select;
    logic [2:0] reg_writeback_select;
    logic [6:0] inst_opcode;
    logic [2:0] inst_funct3;
    logic [6:0] inst_funct7;
    logic [1:0] next_pc_select;
    logic [4:0] alu_function;
    logic alu_result_equal_zero;
    logic [31:0] read_data;
    logic [31:0] write_data;
    logic [31:0] address;
    logic read_enable;
    logic write_enable;

    singlecycle_datapath singlecycle_datapath (
        .clock                  (clock),
        .reset                  (reset),
        .inst                   (inst),
        .data_mem_read_data     (read_data),
        .data_mem_address       (address),
        .data_mem_write_data    (write_data),
        .pc                     (pc),
        .inst_opcode            (inst_opcode),
        .inst_funct3            (inst_funct3),
        .inst_funct7            (inst_funct7),
        .pc_write_enable        (pc_write_enable),
        .regfile_write_enable   (regfile_write_enable),
        .alu_operand_a_select   (alu_operand_a_select),
        .alu_operand_b_select   (alu_operand_b_select),
        .reg_writeback_select   (reg_writeback_select),
        .next_pc_select         (next_pc_select),
        .alu_result_equal_zero  (alu_result_equal_zero),
        .alu_function           (alu_function)
    );

    singlecycle_ctlpath singlecycle_ctlpath(
        .inst_opcode            (inst_opcode),
        .inst_funct3            (inst_funct3),
        .inst_funct7            (inst_funct7),
        .alu_result_equal_zero  (alu_result_equal_zero),
        .pc_write_enable        (pc_write_enable),
        .regfile_write_enable   (regfile_write_enable),
        .alu_operand_a_select   (alu_operand_a_select),
        .alu_operand_b_select   (alu_operand_b_select),
        .data_mem_read_enable   (read_enable),
        .data_mem_write_enable  (write_enable),
        .reg_writeback_select   (reg_writeback_select),
        .alu_function           (alu_function),
        .next_pc_select         (next_pc_select)
    );
    
    data_memory_interface data_memory_interface (
        .clock                  (clock),
        .read_enable            (read_enable),
        .write_enable           (write_enable),
        .data_format            (inst_funct3),
        .address                (address),
        .write_data             (write_data),
        .read_data              (read_data),
        .bus_address            (bus_address),
        .bus_read_data          (bus_read_data),
        .bus_write_data         (bus_write_data),
        .bus_read_enable        (bus_read_enable),
        .bus_write_enable       (bus_write_enable),
        .bus_byte_enable        (bus_byte_enable)
    );
    
endmodule


// ======== core/singlecycle/singlecycle_control.sv ========
// RISC-V SiMPLE SV -- single-cycle controller
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module singlecycle_control (
    input  [6:0] inst_opcode,
    input  take_branch,
    output logic pc_write_enable,
    output logic regfile_write_enable,
    output logic alu_operand_a_select,
    output logic alu_operand_b_select,
    output logic [1:0] alu_op_type,
    output logic data_mem_read_enable,
    output logic data_mem_write_enable,
    output logic [2:0] reg_writeback_select,
    output logic [1:0] next_pc_select
);

    always_comb
        case (inst_opcode)
            `OPCODE_BRANCH: next_pc_select = take_branch ? `CTL_PC_PC_IMM : `CTL_PC_PC4;
            `OPCODE_JALR:   next_pc_select = `CTL_PC_RS1_IMM;
            `OPCODE_JAL:    next_pc_select = `CTL_PC_PC_IMM;
            default:        next_pc_select = `CTL_PC_PC4;
        endcase

    always_comb begin
        pc_write_enable         = 1'b1;
        regfile_write_enable    = 1'b0;
        alu_operand_a_select    = 1'bx;
        alu_operand_b_select    = 1'bx;
        alu_op_type             = 2'bx;
        data_mem_read_enable    = 1'b0;
        data_mem_write_enable   = 1'b0;
        reg_writeback_select    = 3'bx;
    
        case (inst_opcode)
            `OPCODE_LOAD:
            begin
                regfile_write_enable    = 1'b1;
                alu_operand_a_select    = `CTL_ALU_A_RS1;
                alu_operand_b_select    = `CTL_ALU_B_IMM;
                alu_op_type             = `CTL_ALU_ADD;
                data_mem_read_enable    = 1'b1;
                reg_writeback_select    = `CTL_WRITEBACK_DATA;
            end
    
            `OPCODE_MISC_MEM:
            begin
                // Fence - ignore
            end
    
            `OPCODE_OP_IMM:
            begin
                regfile_write_enable    = 1'b1;
                alu_operand_a_select    = `CTL_ALU_A_RS1;
                alu_operand_b_select    = `CTL_ALU_B_IMM;
                alu_op_type             = `CTL_ALU_OP_IMM;
                reg_writeback_select    = `CTL_WRITEBACK_ALU;
            end
    
            `OPCODE_AUIPC:
            begin
                regfile_write_enable    = 1'b1;
                alu_operand_a_select    = `CTL_ALU_A_PC;
                alu_operand_b_select    = `CTL_ALU_B_IMM;
                alu_op_type             = `CTL_ALU_ADD;
                reg_writeback_select    = `CTL_WRITEBACK_ALU;
            end
    
            `OPCODE_STORE:
            begin
                alu_operand_a_select    = `CTL_ALU_A_RS1;
                alu_operand_b_select    = `CTL_ALU_B_IMM;
                alu_op_type             = `CTL_ALU_ADD;
                data_mem_write_enable   = 1'b1;
            end
    
            `OPCODE_OP:
            begin
                regfile_write_enable    = 1'b1;
                alu_operand_a_select    = `CTL_ALU_A_RS1;
                alu_operand_b_select    = `CTL_ALU_B_RS2;
                reg_writeback_select    = `CTL_WRITEBACK_ALU;
                alu_op_type             = `CTL_ALU_OP;
            end
    
            `OPCODE_LUI:
            begin
                regfile_write_enable    = 1'b1;
                alu_operand_a_select    = `CTL_ALU_A_RS1;
                alu_operand_b_select    = `CTL_ALU_B_RS2;
                reg_writeback_select    = `CTL_WRITEBACK_IMM;
            end
    
            `OPCODE_BRANCH:
            begin
                alu_operand_a_select    = `CTL_ALU_A_RS1;
                alu_operand_b_select    = `CTL_ALU_B_RS2;
                alu_op_type             = `CTL_ALU_BRANCH;
            end
    
            `OPCODE_JALR:
            begin
                regfile_write_enable    = 1'b1;
                alu_operand_a_select    = `CTL_ALU_A_RS1;
                alu_operand_b_select    = `CTL_ALU_B_IMM;
                alu_op_type             = `CTL_ALU_ADD;
                reg_writeback_select    = `CTL_WRITEBACK_PC4;
            end
    
            `OPCODE_JAL:
            begin
                regfile_write_enable    = 1'b1;
                alu_operand_a_select    = `CTL_ALU_A_PC;
                alu_operand_b_select    = `CTL_ALU_B_IMM;
                alu_op_type             = `CTL_ALU_ADD;
                reg_writeback_select    = `CTL_WRITEBACK_PC4;
            end
    
            default:
            begin
                pc_write_enable         = 1'bx;
                regfile_write_enable    = 1'bx;
                data_mem_read_enable    = 1'bx;
                data_mem_write_enable   = 1'bx;
            end
        endcase
    end

endmodule


// ======== core/singlecycle/singlecycle_ctlpath.sv ========
// RISC-V SiMPLE SV -- control path
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module singlecycle_ctlpath (
    input  [6:0] inst_opcode,
    input  [2:0] inst_funct3,
    input  [6:0] inst_funct7,
    input  alu_result_equal_zero,

    output pc_write_enable,
    output regfile_write_enable,
    output alu_operand_a_select,
    output alu_operand_b_select,
    output data_mem_read_enable,
    output data_mem_write_enable,
    output [2:0] reg_writeback_select,
    output [4:0] alu_function,
    output [1:0] next_pc_select
);

    logic take_branch;
    logic [1:0] alu_op_type;

    singlecycle_control singlecycle_control(
        .inst_opcode            (inst_opcode),
        .pc_write_enable        (pc_write_enable),
        .regfile_write_enable   (regfile_write_enable),
        .alu_operand_a_select   (alu_operand_a_select),
        .alu_operand_b_select   (alu_operand_b_select),
        .alu_op_type            (alu_op_type),
        .data_mem_read_enable   (data_mem_read_enable),
        .data_mem_write_enable  (data_mem_write_enable),
        .reg_writeback_select   (reg_writeback_select),
        .take_branch            (take_branch),
        .next_pc_select         (next_pc_select)
    );

    control_transfer control_transfer (
        .result_equal_zero  (alu_result_equal_zero),
        .inst_funct3        (inst_funct3),
        .take_branch        (take_branch)
    );

    alu_control alu_control(
        .alu_op_type        (alu_op_type),
        .inst_funct3        (inst_funct3),
        .inst_funct7        (inst_funct7),
        .alu_function       (alu_function)
    );

endmodule


// ======== core/singlecycle/singlecycle_datapath.sv ========
// RISC-V SiMPLE SV -- single-cycle data path
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module singlecycle_datapath (
    input  clock,
    input  reset,

    input  [31:0] data_mem_read_data,
    output [31:0] data_mem_address,
    output [31:0] data_mem_write_data,

    input  [31:0] inst,
    output [31:0] pc,

    output [6:0] inst_opcode,
    output [2:0] inst_funct3,
    output [6:0] inst_funct7,
    output alu_result_equal_zero,
    
    // control signals
    input pc_write_enable,
    input regfile_write_enable,
    input alu_operand_a_select,
    input alu_operand_b_select,
    input [2:0] reg_writeback_select,
    input [1:0] next_pc_select,
    input [4:0] alu_function
);

    // register file inputs and outputs
    logic [31:0] rd_data;
    logic [31:0] rs1_data;
    logic [31:0] rs2_data;
    logic  [4:0]  inst_rd;
    logic  [4:0]  inst_rs1;
    logic  [4:0]  inst_rs2;
    
    // program counter signals
    logic [31:0] pc_plus_4;
    logic [31:0] pc_plus_immediate;
    logic [31:0] next_pc;
    
    // ALU signals
    logic [31:0] alu_operand_a;
    logic [31:0] alu_operand_b;
    logic [31:0] alu_result;
    
    // immediate
    logic [31:0] immediate;
    
    // memory signals
    assign data_mem_address     = alu_result;
    assign data_mem_write_data  = rs2_data;
    
    adder #(
        .WIDTH(32)
    ) adder_pc_plus_4 (
        .operand_a      (32'h00000004),
        .operand_b      (pc),
        .result         (pc_plus_4)
    );
    
    adder #(
       .WIDTH(32)
    ) adder_pc_plus_immediate (
        .operand_a      (pc),
        .operand_b      (immediate),
        .result         (pc_plus_immediate)
    );
    
    alu alu(
        .alu_function       (alu_function),
        .operand_a          (alu_operand_a),
        .operand_b          (alu_operand_b),
        .result             (alu_result),
        .result_equal_zero  (alu_result_equal_zero)
    );
    
    multiplexer4 #(
        .WIDTH(32)
    ) mux_next_pc_select (
        .in0 (pc_plus_4),
        .in1 (pc_plus_immediate),
        .in2 ({alu_result[31:1], 1'b0}),
        .in3 (32'b0),
        .sel (next_pc_select),
        .out (next_pc)
    );
    
    multiplexer2 #(
        .WIDTH(32)
    ) mux_operand_a (
        .in0 (rs1_data),
        .in1 (pc),
        .sel (alu_operand_a_select),
        .out (alu_operand_a)
    );
    
    multiplexer2 #(
        .WIDTH(32)
    ) mux_operand_b (
        .in0 (rs2_data),
        .in1 (immediate),
        .sel (alu_operand_b_select),
        .out (alu_operand_b)
    );
    
    multiplexer8 #(
        .WIDTH(32)
    ) mux_reg_writeback (
        .in0 (alu_result),
        .in1 (data_mem_read_data),
        .in2 (pc_plus_4),
        .in3 (immediate),
        .in4 (32'b0),
        .in5 (32'b0),
        .in6 (32'b0),
        .in7 (32'b0),
        .sel (reg_writeback_select),
        .out (rd_data)
    );
    
    register #(
        .WIDTH(32),
        .INITIAL(`INITIAL_PC)
    ) program_counter(
        .clock              (clock),
        .reset              (reset),
        .write_enable       (pc_write_enable),
        .next               (next_pc),
        .value              (pc)
    );
    
    regfile regfile(
        .clock              (clock),
        .write_enable       (regfile_write_enable),
        .rd_address         (inst_rd),
        .rs1_address        (inst_rs1),
        .rs2_address        (inst_rs2),
        .rd_data            (rd_data),
        .rs1_data           (rs1_data),
        .rs2_data           (rs2_data)
    );

    instruction_decoder instruction_decoder(
        .inst                   (inst),
        .inst_opcode            (inst_opcode),
        .inst_funct7            (inst_funct7),
        .inst_funct3            (inst_funct3),
        .inst_rd                (inst_rd),
        .inst_rs1               (inst_rs1),
        .inst_rs2               (inst_rs2)
    );
    
    immediate_generator immediate_generator(
        .inst                   (inst),
        .immediate              (immediate)
    );
    
endmodule


// ======== core/common/adder.sv ========
// RISC-V SiMPLE SV -- adder module
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module adder #(
    parameter  WIDTH = 32
) (
    input  [WIDTH-1:0] operand_a,
    input  [WIDTH-1:0] operand_b,
    output [WIDTH-1:0] result
);

    assign result = operand_a + operand_b;

endmodule


// ======== core/common/alu.sv ========
// RISC-V SiMPLE SV -- ALU module
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module alu (
    input        [4:0]  alu_function,
    input signed [31:0] operand_a,
    input signed [31:0] operand_b,
    output logic [31:0] result,
    output              result_equal_zero
);

    `ifdef M_MODULE
        logic [63:0] signed_multiplication;
        logic [63:0] unsigned_multiplication;
        logic [63:0] signed_unsigned_multiplication;
    `endif
    
    assign result_equal_zero = (result == 32'b0);
    
    always_comb begin
        result = `ZERO;
        case (alu_function)
            `ALU_ADD:   result = operand_a +    operand_b;
            `ALU_SUB:   result = operand_a -    operand_b;
            `ALU_SLL:   result = operand_a <<   operand_b[4:0];
            `ALU_SRL:   result = operand_a >>   operand_b[4:0];
            `ALU_SRA:   result = operand_a >>>  operand_b[4:0];
            `ALU_SEQ:   result = {31'b0, operand_a == operand_b};
            `ALU_SLT:   result = {31'b0, operand_a < operand_b};
            `ALU_SLTU:  result = {31'b0, $unsigned(operand_a) < $unsigned(operand_b)};
            `ALU_XOR:   result = operand_a ^    operand_b;
            `ALU_OR:    result = operand_a |    operand_b;
            `ALU_AND:   result = operand_a &    operand_b;
    `ifdef M_MODULE
            `ALU_MUL:   result = signed_multiplication[31:0];
            `ALU_MULH:  result = signed_multiplication[63:32];
            `ALU_MULHSU:    result = signed_unsigned_multiplication[63:32];
            `ALU_MULHU: result = unsigned_multiplication[63:32];
            `ALU_DIV:
                if (operand_b == `ZERO)
                    result = 32'b1;
                else if ((operand_a == 32'h80000000) && (operand_b == 32'b1))
                    result = 32'h80000000;
                else
                    result = operand_a / operand_b;
            `ALU_DIVU:
                if (operand_b == `ZERO)
                    result = 32'b1;
                else
                    result = $unsigned(operand_a) / $unsigned(operand_b);
            `ALU_REM:
                if (operand_b == `ZERO)
                    result = operand_a;
                else if ((operand_a == 32'h80000000) && (operand_b == 32'b1))
                    result = `ZERO;
                else
                    result = operand_a % operand_b;
            `ALU_REMU:
                if (operand_b == `ZERO)
                    result = operand_a;
                else
                    result = $unsigned(operand_a) % $unsigned(operand_b);
    `endif
            default:
                result = `ZERO;
        endcase
    end
    
    `ifdef M_MODULE
        always_comb begin
            signed_multiplication   = operand_a * operand_b;
            unsigned_multiplication = $unsigned(operand_a) * $unsigned(operand_b);
            signed_unsigned_multiplication = $signed(operand_a) * $unsigned(operand_b);
        end
    `endif

endmodule


// ======== core/common/alu_control.sv ========
// RISC-V SiMPLE SV -- ALU controller module
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module alu_control (
    input        [1:0] alu_op_type,
    input        [2:0] inst_funct3,
    input        [6:0] inst_funct7,
    output logic [4:0] alu_function
);

    logic [4:0] default_funct;
    logic [4:0] secondary_funct;
    logic [4:0] op_funct;
    logic [4:0] op_imm_funct;
    logic [4:0] branch_funct;
    `ifdef M_MODULE
    logic [4:0] m_extension_funct;
    `endif
    
    always_comb
        case (alu_op_type)
            `CTL_ALU_ADD:           alu_function = `ALU_ADD;
            `CTL_ALU_OP:            alu_function = op_funct;
            `CTL_ALU_OP_IMM:        alu_function = op_imm_funct;
            `CTL_ALU_BRANCH:        alu_function = branch_funct;
            default:                alu_function = 5'bx;
        endcase

    always_comb
        if (inst_funct7[5])     op_funct = secondary_funct;
    `ifdef M_MODULE
        else if(inst_funct7[0]) op_funct = m_extension_funct;
    `endif
        else                    op_funct = default_funct;

    always_comb
        if (inst_funct7[5] && inst_funct3[1:0] == 2'b01)
                op_imm_funct = secondary_funct;
        else    op_imm_funct = default_funct;

    always_comb
        case (inst_funct3)
            `FUNCT3_ALU_ADD_SUB:    default_funct = `ALU_ADD;
            `FUNCT3_ALU_SLL:        default_funct = `ALU_SLL;
            `FUNCT3_ALU_SLT:        default_funct = `ALU_SLT;
            `FUNCT3_ALU_SLTU:       default_funct = `ALU_SLTU;
            `FUNCT3_ALU_XOR:        default_funct = `ALU_XOR;
            `FUNCT3_ALU_SHIFTR:     default_funct = `ALU_SRL;
            `FUNCT3_ALU_OR:         default_funct = `ALU_OR;
            `FUNCT3_ALU_AND:        default_funct = `ALU_AND;
            default:                default_funct = 5'bx;
        endcase
    
    always_comb
        case (inst_funct3)
            `FUNCT3_ALU_ADD_SUB:    secondary_funct = `ALU_SUB;
            `FUNCT3_ALU_SHIFTR:     secondary_funct = `ALU_SRA;
            default:                secondary_funct = 5'bx;
        endcase
    
    always_comb
        case (inst_funct3)
            `FUNCT3_BRANCH_EQ:  branch_funct = `ALU_SEQ;
            `FUNCT3_BRANCH_NE:  branch_funct = `ALU_SEQ;
            `FUNCT3_BRANCH_LT:  branch_funct = `ALU_SLT;
            `FUNCT3_BRANCH_GE:  branch_funct = `ALU_SLT;
            `FUNCT3_BRANCH_LTU: branch_funct = `ALU_SLTU;
            `FUNCT3_BRANCH_GEU: branch_funct = `ALU_SLTU;
            default:            branch_funct = 5'bx;
        endcase
    
    `ifdef M_MODULE
        always_comb
            case (inst_funct3)
                `FUNCT3_ALU_MUL:    m_extension_funct = `ALU_MUL;
                `FUNCT3_ALU_MULH:   m_extension_funct = `ALU_MULH;
                `FUNCT3_ALU_MULHSU: m_extension_funct = `ALU_MULHSU;
                `FUNCT3_ALU_MULHU:  m_extension_funct = `ALU_MULHU;
                `FUNCT3_ALU_DIV:    m_extension_funct = `ALU_DIV;
                `FUNCT3_ALU_DIVU:   m_extension_funct = `ALU_DIVU;
                `FUNCT3_ALU_REM:    m_extension_funct = `ALU_REM;
                `FUNCT3_ALU_REMU:   m_extension_funct = `ALU_REMU;
                default:            m_extension_funct = 5'bx;
            endcase
    `endif

endmodule


// ======== core/common/control_transfer.sv ========
// RISC-V SiMPLE SV -- control transfer unit
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module control_transfer (
    input        result_equal_zero,
    input [2:0]  inst_funct3,
    output logic take_branch
);

    always_comb
        case (inst_funct3)
            `FUNCT3_BRANCH_EQ:  take_branch = !result_equal_zero;
            `FUNCT3_BRANCH_NE:  take_branch = result_equal_zero;
            `FUNCT3_BRANCH_LT:  take_branch = !result_equal_zero;
            `FUNCT3_BRANCH_GE:  take_branch = result_equal_zero;
            `FUNCT3_BRANCH_LTU: take_branch = !result_equal_zero;
            `FUNCT3_BRANCH_GEU: take_branch = result_equal_zero;
            default: take_branch = 1'bx;
        endcase

endmodule


// ======== core/common/data_memory_interface.sv ========
// RISC-V SiMPLE SV -- data memory interface
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module data_memory_interface (
    input  clock,
    input  read_enable,
    input  write_enable,
    input  [2:0]  data_format,
    input  [31:0] address,
    input  [31:0] write_data,
    output [31:0] read_data,

    output       [31:0] bus_address,
    input        [31:0] bus_read_data,
    output       [31:0] bus_write_data,
    output logic [3:0]  bus_byte_enable,
    output              bus_read_enable,
    output              bus_write_enable
);

    logic [31:0] position_fix;
    logic [31:0] sign_fix;

    assign bus_address      = address;
    assign bus_write_enable = write_enable;
    assign bus_read_enable  = read_enable;
    assign bus_write_data   = write_data << (8*address[1:0]);
    
    // calculate byte enable
    always_comb begin
       bus_byte_enable = 4'b0000;
       case (data_format[1:0])
           2'b00:   bus_byte_enable = 4'b0001 << address[1:0];
           2'b01:   bus_byte_enable = 4'b0011 << address[1:0];
           2'b10:   bus_byte_enable = 4'b1111 << address[1:0];
           default: bus_byte_enable = 4'b0000;
       endcase
    end
    
    // correct for unaligned accesses
    always_comb begin
       position_fix = bus_read_data >> (8*address[1:0]);
    end
    
    // sign-extend if necessary
    always_comb begin
       case (data_format[1:0])
           2'b00:   sign_fix = {{24{~data_format[2] & position_fix[7]}}, position_fix[7:0]};
           2'b01:   sign_fix = {{16{~data_format[2] & position_fix[15]}}, position_fix[15:0]};
           2'b10:   sign_fix = position_fix[31:0];
           default: sign_fix = 32'bx;
       endcase
    end

    assign read_data = sign_fix;
    
endmodule


// ======== core/common/example_data_memory.sv ========
// RISC-V SiMPLE SV -- data memory model
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module example_data_memory (
	input [`DATA_BITS-3:0] address,
	input [3:0] byteena,
	input clock,
	input [31:0] data,
	input wren,
	output [31:0] q
);

    (* nomem2reg *)
    logic [31:0] mem[0:2**(`DATA_BITS-2)-1];

    assign q = mem[address];

    always_ff @(posedge clock)
        if (wren) begin
            if (byteena[0]) mem[address][0+:8] <= data[0+:8];
            if (byteena[1]) mem[address][8+:8] <= data[8+:8];
            if (byteena[2]) mem[address][16+:8] <= data[16+:8];
            if (byteena[3]) mem[address][24+:8] <= data[24+:8];
        end

`ifdef DATA_HEX
    initial $readmemh(`DATA_HEX, mem);
`endif

endmodule


// ======== core/common/example_data_memory_bus.sv ========
// RISC-V SiMPLE SV -- data memory bus
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module example_data_memory_bus (
    input  clock,
    input  [31:0] address,
    output [31:0] read_data,
    input  [31:0] write_data,
    input   [3:0] byte_enable,
    input         read_enable,
    input         write_enable
);

    logic [31:0] fetched;
    logic is_data_memory;
    
    assign is_data_memory = address >= `DATA_BEGIN && address <= `DATA_END;
    
    example_data_memory data_memory(
        .clock      (clock),
        .address    (address[`DATA_BITS-1:2]),
        .byteena    (byte_enable),
        .data       (write_data),
        .wren       (write_enable && is_data_memory),
        .q          (fetched)
    );
   
    assign read_data = 
        read_enable && is_data_memory
        ? fetched
        : 32'hxxxxxxxx;

endmodule


// ======== core/common/example_memory_bus.sv ========
// RISC-V SiMPLE SV -- combined text/data memory bus
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module example_memory_bus (
    input  clock,
    input  [31:0] address,
    output [31:0] read_data,
    input  [31:0] write_data,
    input   [3:0] byte_enable,
    input         read_enable,
    input         write_enable
);

    logic [31:0] text_fetched, data_fetched;
    logic is_data_memory;
    
    assign is_data_memory = address >= `DATA_BEGIN && address <= `DATA_END;
    
    example_data_memory data_memory(
        .clock      (clock),
        .address    (address[`DATA_BITS-1:2]),
        .byteena    (byte_enable),
        .data       (write_data),
        .wren       (write_enable && is_data_memory),
        .q          (data_fetched)
    );
   
    example_text_memory text_memory(
        .address    (address[`TEXT_BITS-1:2]),
        .clock      (clock),
        .q          (text_fetched)
    );
   
    assign read_data = 
          read_enable && address >= `TEXT_BEGIN && address <= `TEXT_END
        ? text_fetched
        : read_enable && is_data_memory
        ? data_fetched
        : 32'hxxxxxxxx;

endmodule


// ======== core/common/example_text_memory.sv ========
// RISC-V SiMPLE SV -- text memory model
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module example_text_memory (
    input [`TEXT_BITS-3:0] address,
    input clock,
    output [31:0] q
);
    (* nomem2reg *)
    logic [31:0] mem[0:2**(`TEXT_BITS-2)-1];

    assign q = mem[address];

`ifdef TEXT_HEX
    initial $readmemh(`TEXT_HEX, mem);
`endif

endmodule


// ======== core/common/example_text_memory_bus.sv ========
// RISC-V SiMPLE SV -- program text memory bus
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module example_text_memory_bus (
    input  clock,
    input  [31:0] address,
    output [31:0] read_data
);

    logic [31:0] fetched;
    
    example_text_memory text_memory(
        .address    (address[`TEXT_BITS-1:2]),
        .clock      (clock),
        .q          (fetched)
    );
   
    assign read_data = 
        address >= `TEXT_BEGIN && address <= `TEXT_END
        ? fetched
        : 32'hxxxxxxxx;

endmodule


// ======== core/common/immediate_generator.sv ========
// RISC-V SiMPLE SV -- immediate generator
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module immediate_generator (
    input        [31:0] inst,
    output logic [31:0] immediate
);

    // Immediate format
    //       31.............30........20.19........12.11.....11.10.........5.4..........1.0.....0
    // I = { {21{inst[31]}},                                     inst[30:25], inst[24:20]         };
    // S = { {21{inst[31]}},                                     inst[30:25], inst[11:7]          };
    // B = { {20{inst[31]}}, inst[7],                            inst[30:25], inst[11:8],   1'b0  };
    // U = { {1{inst[31]}},  inst[30:20], inst[19:12],                                      12'b0 };
    // J = { {12{inst[31]}},              inst[19:12], inst[20], inst[30:25], inst[24:21],  1'b0  };
    
    always_comb begin
        immediate = 32'b0;
        case (inst[6:0]) // Opcode
            `OPCODE_LOAD,
            `OPCODE_LOAD_FP,
            `OPCODE_OP_IMM,
            `OPCODE_JALR:   // I-type immediate
                immediate = { {21{inst[31]}}, inst[30:25], inst[24:20] };
            `OPCODE_STORE_FP,
            `OPCODE_STORE:  // S-type immediate
                immediate = { {21{inst[31]}}, inst[30:25], inst[11:7] };
            `OPCODE_BRANCH: // B-type immediate
                immediate = { {20{inst[31]}}, inst[7], inst[30:25], inst[11:8], 1'b0 };
            `OPCODE_AUIPC,
            `OPCODE_LUI:    // U-type immediate
                immediate = { {1{inst[31]}}, inst[30:20], inst[19:12], 12'b0 };
            `OPCODE_JAL:    // J-type immediate
                immediate = { {12{inst[31]}}, inst[19:12], inst[20], inst[30:25], inst[24:21], 1'b0 };
            default: immediate = 32'b0;
        endcase
    end

endmodule


// ======== core/common/instruction_decoder.sv ========
// RISC-V SiMPLE SV -- instruction decoder
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module instruction_decoder(
    input [31:0] inst,
    output [6:0] inst_opcode,
    output [2:0] inst_funct3,
    output [6:0] inst_funct7,
    output [4:0] inst_rd,
    output [4:0] inst_rs1,
    output [4:0] inst_rs2
);

    assign inst_opcode = inst[6:0];
    assign inst_funct3 = inst[14:12];
    assign inst_funct7 = inst[31:25];
    assign inst_rd     = inst[11:7];
    assign inst_rs1    = inst[19:15];
    assign inst_rs2    = inst[24:20];

endmodule

// ======== core/common/multiplexer.sv ========
// RISC-V SiMPLE SV -- multiplexer module
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module multiplexer #(
    parameter  WIDTH    = 32,
    parameter  CHANNELS = 2) (
        input  [(CHANNELS * WIDTH) - 1:0]   in_bus,
        input  [$clog2(CHANNELS) - 1:0]     sel,
        output [WIDTH - 1:0]                out
);

    genvar ig;
    
    logic  [WIDTH - 1:0] input_array [0:CHANNELS - 1];
    
    assign out = input_array[sel];
    
    for(ig = 0; ig < CHANNELS; ig = ig + 1) begin: array_assignments
        assign input_array[(CHANNELS - 1) - ig] = in_bus[(ig * WIDTH) +: WIDTH];
    end

endmodule


// ======== core/common/multiplexer2.sv ========
// RISC-V SiMPLE SV -- multiplexer module
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module multiplexer2 #(
    parameter  WIDTH = 32
) (
    input  [WIDTH-1:0] in0,
    input  [WIDTH-1:0] in1,
    input              sel,
    output [WIDTH-1:0] out
);

    multiplexer #(
        .WIDTH(WIDTH),
        .CHANNELS(2)
    ) multiplexer (
        .in_bus({in0, in1}),
        .sel(sel),
        .out(out)
    );

endmodule


// ======== core/common/multiplexer4.sv ========
// RISC-V SiMPLE SV -- multiplexer module
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module multiplexer4 #(
    parameter  WIDTH = 32
) (
    input  [WIDTH-1:0] in0,
    input  [WIDTH-1:0] in1,
    input  [WIDTH-1:0] in2,
    input  [WIDTH-1:0] in3,
    input  [1:0]       sel,
    output [WIDTH-1:0] out
);

    multiplexer #(
        .WIDTH(WIDTH),
        .CHANNELS(4)
    ) multiplexer (
        .in_bus({in0, in1, in2, in3}),
        .sel(sel),
        .out(out)
    );

endmodule


// ======== core/common/multiplexer8.sv ========
// RISC-V SiMPLE SV -- multiplexer module
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module multiplexer8 #(
    parameter  WIDTH = 32
) (
    input  [WIDTH-1:0] in0,
    input  [WIDTH-1:0] in1,
    input  [WIDTH-1:0] in2,
    input  [WIDTH-1:0] in3,
    input  [WIDTH-1:0] in4,
    input  [WIDTH-1:0] in5,
    input  [WIDTH-1:0] in6,
    input  [WIDTH-1:0] in7,
    input  [2:0]       sel,
    output [WIDTH-1:0] out
);

    multiplexer #(
        .WIDTH(WIDTH),
        .CHANNELS(8)
    ) multiplexer (
        .in_bus({in0, in1, in2, in3, in4, in5, in6, in7}),
        .sel(sel),
        .out(out)
    );

endmodule


// ======== core/common/regfile.sv ========
// RISC-V SiMPLE SV -- register file
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module regfile (
    input  clock,
    input  write_enable,
    input  [4:0] rd_address,
    input  [4:0] rs1_address,
    input  [4:0] rs2_address,
    input  [31:0] rd_data,
    output [31:0] rs1_data,
    output [31:0] rs2_data
);

    // 32 registers of 32-bit width
    logic [31:0] register [0:31];
   
    // Read ports for rs1 and rs2
    assign rs1_data = register[rs1_address];
    assign rs2_data = register[rs2_address];

    // Register x0 is always 0
    initial register[0] = 32'b0;

    // Write port for rd
    always_ff @(posedge clock)
        if (write_enable)
            if (rd_address != 5'b0) register[rd_address] <= rd_data;

endmodule


// ======== core/common/register.sv ========
// RISC-V SiMPLE SV -- generic register
// BSD 3-Clause License
// (c) 2017-2019, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław

module register #(
    parameter  WIDTH    = 32,
    parameter  INITIAL  = 0
) (
    input  clock,
    input  reset,
    input  write_enable,
    input  [WIDTH-1:0] next,

    output logic [WIDTH-1:0] value
);

   initial value = INITIAL;
   
   always_ff @ (posedge clock or posedge reset)
       if (reset) value <= INITIAL;
       else if (write_enable) value <= next;

endmodule

