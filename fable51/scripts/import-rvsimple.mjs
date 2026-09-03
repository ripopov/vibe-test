// Assemble the riscv-simple-sv cores (https://github.com/tilk/riscv-simple-sv) into single-file
// examples: node scripts/import-rvsimple.mjs <path-to-checkout>
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: node scripts/import-rvsimple.mjs <riscv-simple-sv checkout>');
  process.exit(1);
}
const read = (p) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (src) => src.replace(/^`include\s+"(config|constants)\.sv"\s*\n/gm, '');
const common = readdirSync(join(root, 'core/common')).filter((f) => f.endsWith('.sv') && f !== 'constants.sv').sort();

for (const core of ['singlecycle', 'multicycle', 'pipeline']) {
  const files = readdirSync(join(root, `core/${core}`)).filter((f) => f.endsWith('.sv')).sort();
  // top level first so the viewer opens on it
  files.sort((a, b) => (a === 'toplevel.sv' ? -1 : b === 'toplevel.sv' ? 1 : a.localeCompare(b)));
  let out = `// RISC-V SiMPLE SV -- ${core} core, assembled into one file for the schematic viewer.
// Source: https://github.com/tilk/riscv-simple-sv (BSD 3-Clause License)
// (c) 2017-2021, Arthur Matos, Marcus Vinicius Lamar, Universidade de Brasília,
//                Marek Materzok, University of Wrocław
//
// Files are concatenated in this order: synth/config.sv, core/common/constants.sv,
// core/${core}/*.sv, core/common/*.sv. The \`include lines of the original files were removed
// because the configuration and constants are inlined below.

`;
  out += '// ======== synth/config.sv ========\n' + read('synth/config.sv') + '\n';
  out += '// ======== core/common/constants.sv ========\n' + read('core/common/constants.sv') + '\n';
  for (const f of files) out += `// ======== core/${core}/${f} ========\n` + strip(read(`core/${core}/${f}`)) + '\n';
  for (const f of common) out += `// ======== core/common/${f} ========\n` + strip(read(`core/common/${f}`)) + '\n';
  const dst = `src/examples/rvsimple_${core}.sv`;
  writeFileSync(dst, out);
  console.log(`${dst}: ${out.split('\n').length} lines`);
}
