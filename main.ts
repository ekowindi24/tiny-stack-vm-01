// Tiny stack VM: a faithful interpreter of make.fun's tiny-stack-vm-01 ISA
// (32-bit wrapping values, 256-value stack, 64-deep call stack, 256 memory
// words, ten traps, 1M-step and 64K-output limits). The program is decoded
// once into flat tables so the hot loop only indexes arrays; every byte
// position is decoded, since a jump may land on any byte.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const POPS = new Int8Array(256);
const PUSHES = new Int8Array(256);
{
  // [opcode, pops, pushes] for every opcode that is not a 2-in/1-out binary op.
  for (const [o, p, q] of [[1, 0, 1], [2, 0, 1], [3, 1, 0], [4, 1, 2], [5, 2, 2], [6, 2, 3], [7, 3, 3], [0x17, 1, 1], [0x1b, 1, 1], [0x31, 1, 0], [0x32, 1, 0], [0x40, 1, 1], [0x41, 2, 0], [0x50, 1, 0], [0x51, 1, 0], [0x52, 0, 1], [0x53, 1, 0]]) {
    POPS[o] = p; PUSHES[o] = q;
  }
  for (const o of [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x18, 0x19, 0x1a, 0x1c, 0x1d, 0x1e, 0x20, 0x21, 0x22]) {
    POPS[o] = 2; PUSHES[o] = 1;
  }
}

function run(p: Uint8Array, inp: Uint8Array): { out: Uint8Array; code: number } {
  const n = p.length;
  // Decode tables, one entry per byte position. op: opcode byte, -1 unknown,
  // -2 immediate cut off by the program's end. im: immediate value. nx: next pc.
  const op = new Int32Array(n);
  const im = new Int32Array(n);
  const nx = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const b = p[i];
    if (!(b <= 0x07 || (b >= 0x10 && b <= 0x22) || (b >= 0x30 && b <= 0x34) || b === 0x40 || b === 0x41 || (b >= 0x50 && b <= 0x53))) { op[i] = -1; continue; }
    const len = b === 0x01 ? 1 : b === 0x02 ? 4 : b >= 0x30 && b <= 0x33 ? 2 : 0;
    if (len > 0 && i + len >= n) { op[i] = -2; continue; }
    op[i] = b;
    nx[i] = i + 1 + len;
    if (b === 0x01) im[i] = (p[i + 1] << 24) >> 24;
    else if (b === 0x02) im[i] = p[i + 1] | (p[i + 2] << 8) | (p[i + 3] << 16) | (p[i + 4] << 24);
    else if (b === 0x30 || b === 0x31 || b === 0x32) im[i] = ((p[i + 1] | (p[i + 2] << 8)) << 16) >> 16;
    else if (b === 0x33) im[i] = p[i + 1] | (p[i + 2] << 8);
  }
  const D = new Int32Array(256);
  const C = new Int32Array(64);
  const M = new Int32Array(256);
  const out = new Uint8Array(65536);
  let olen = 0, sp = 0, csp = 0, pc = 0, steps = 0, ipos = 0;
  const done = (code: number): { out: Uint8Array; code: number } => ({ out: out.slice(0, olen), code });
  for (;;) {
    if (steps === 1000000) return done(10);
    if (pc < 0 || pc >= n) return done(9);
    const o = op[pc];
    if (o === -1) return done(5);
    if (o === -2) return done(9);
    steps++;
    if (sp < POPS[o]) return done(2);
    if (sp - POPS[o] + PUSHES[o] > 256) return done(3);
    const here = pc;
    pc = nx[here];
    switch (o) {
      case 0x00: return done(0);
      case 0x01: case 0x02: D[sp++] = im[here]; break;
      case 0x03: sp--; break;
      case 0x04: D[sp] = D[sp - 1]; sp++; break;
      case 0x05: { const t = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = t; break; }
      case 0x06: D[sp] = D[sp - 2]; sp++; break;
      case 0x07: { const a = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = a; break; }
      case 0x17: D[sp - 1] = -D[sp - 1] | 0; break;
      case 0x1b: D[sp - 1] = ~D[sp - 1]; break;
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22: {
        const b = D[sp - 1], a = D[sp - 2];
        let r: number;
        if (o === 0x10) r = (a + b) | 0;
        else if (o === 0x11) r = (a - b) | 0;
        else if (o === 0x12) r = Math.imul(a, b);
        else if (o === 0x13) {
          if (b === 0) return done(4);
          r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
        } else if (o === 0x14) {
          if (b === 0) return done(4);
          r = b === -1 ? 0 : (a % b) | 0;
        } else if (o === 0x15) {
          if (b === 0) return done(4);
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        } else if (o === 0x16) {
          if (b === 0) return done(4);
          r = ((a >>> 0) % (b >>> 0)) | 0;
        } else if (o === 0x18) r = a & b;
        else if (o === 0x19) r = a | b;
        else if (o === 0x1a) r = a ^ b;
        else if (o === 0x1c) r = a << (b & 31);
        else if (o === 0x1d) r = a >> (b & 31);
        else if (o === 0x1e) r = (a >>> (b & 31)) | 0;
        else if (o === 0x20) r = a === b ? 1 : 0;
        else if (o === 0x21) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0;
        sp -= 2; D[sp++] = r;
        break;
      }
      case 0x30: pc = pc + im[here]; break;
      case 0x31: case 0x32: {
        const v = D[--sp];
        if ((o === 0x31) === (v === 0)) pc = pc + im[here];
        break;
      }
      case 0x33:
        if (csp === 64) return done(7);
        C[csp++] = pc; pc = im[here];
        break;
      case 0x34:
        if (csp === 0) return done(8);
        pc = C[--csp];
        break;
      case 0x40: {
        const addr = D[sp - 1];
        if (addr < 0 || addr >= 256) return done(6);
        D[sp - 1] = M[addr];
        break;
      }
      case 0x41: {
        const addr = D[sp - 1], v = D[sp - 2];
        if (addr < 0 || addr >= 256) return done(6);
        sp -= 2; M[addr] = v;
        break;
      }
      case 0x50: {
        const s = String(D[sp - 1]);
        if (olen + s.length > 65536) return done(11);
        sp--;
        for (let k = 0; k < s.length; k++) out[olen++] = s.charCodeAt(k);
        break;
      }
      case 0x51:
        if (olen + 1 > 65536) return done(11);
        out[olen++] = D[--sp] & 255;
        break;
      case 0x52: D[sp++] = ipos < inp.length ? inp[ipos++] : -1; break;
      case 0x53: return done(D[--sp] & 255);
      default: return done(5);
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const r = run(new Uint8Array(readFileSync(join(I, id, 'program.bin'))), new Uint8Array(readFileSync(join(I, id, 'input.bin'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), `${r.code}\n`);
}
