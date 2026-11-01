/*
 * Small QR code generator (byte mode, error correction level M, versions 1-10).
 * Enough for invite links up to 213 characters. No outside libraries.
 *
 *   const qr = QR.encode('https://example.com/?code=K7M2QX');
 *   qr.size          // modules per side
 *   qr.get(x, y)     // true = dark
 *   QR.toSvg(qr)     // ready-to-insert <svg> markup
 */
(function (root) {
  'use strict';

  // [data codewords per block, number of blocks] groups, EC codewords per block (level M)
  const BLOCKS = {
    1: { ec: 10, groups: [[16, 1]] },
    2: { ec: 16, groups: [[28, 1]] },
    3: { ec: 26, groups: [[44, 1]] },
    4: { ec: 18, groups: [[32, 2]] },
    5: { ec: 24, groups: [[43, 2]] },
    6: { ec: 16, groups: [[27, 4]] },
    7: { ec: 18, groups: [[31, 4]] },
    8: { ec: 22, groups: [[38, 2], [39, 2]] },
    9: { ec: 22, groups: [[36, 3], [37, 2]] },
    10: { ec: 26, groups: [[43, 4], [44, 1]] },
  };
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };
  const EC_LEVEL_M = 0; // format bits for level M

  // ---- Galois field GF(256), primitive polynomial 0x11D
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  function generator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= mul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly; // highest power first, poly[0] === 1
  }

  function ecCodewords(data, degree) {
    const gen = generator(degree);
    const res = new Array(degree).fill(0);
    for (const b of data) {
      const factor = b ^ res[0];
      res.shift();
      res.push(0);
      for (let i = 0; i < degree; i++) res[i] ^= mul(gen[i + 1], factor);
    }
    return res;
  }

  function utf8(text) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
    return Array.from(Buffer.from(text, 'utf8'));
  }

  function dataCapacity(v) {
    return BLOCKS[v].groups.reduce((n, [len, count]) => n + len * count, 0);
  }

  function encode(text, opts) {
    const forceMask = opts && Number.isInteger(opts.mask) ? opts.mask : -1;
    const bytes = utf8(String(text));
    let version = 0;
    for (let v = 1; v <= 10; v++) {
      const countBits = v < 10 ? 8 : 16;
      if (4 + countBits + bytes.length * 8 <= dataCapacity(v) * 8) { version = v; break; }
    }
    if (!version) throw new Error('Text is too long for this QR generator');

    // ---- bit stream: mode 0100 (byte), length, data, terminator, padding
    const cap = dataCapacity(version);
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(0b0100, 4);
    put(bytes.length, version < 10 ? 8 : 16);
    bytes.forEach((b) => put(b, 8));
    put(0, Math.min(4, cap * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);

    // ---- split into blocks, add error correction, interleave
    const { ec, groups } = BLOCKS[version];
    const blocks = [];
    let k = 0;
    for (const [len, count] of groups) {
      for (let i = 0; i < count; i++) {
        const d = data.slice(k, k + len);
        k += len;
        blocks.push({ d, e: ecCodewords(d, ec) });
      }
    }
    const final = [];
    const maxLen = Math.max(...blocks.map((b) => b.d.length));
    for (let i = 0; i < maxLen; i++) blocks.forEach((b) => { if (i < b.d.length) final.push(b.d[i]); });
    for (let i = 0; i < ec; i++) blocks.forEach((b) => final.push(b.e[i]));

    // ---- draw
    const size = version * 4 + 17;
    const mods = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { mods[y][x] = !!dark; fn[y][x] = true; };

    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); } // timing

    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          set(x, y, d !== 2 && d !== 4);
        }
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

    const pos = ALIGN[version];
    for (const ay of pos) {
      for (const ax of pos) {
        if ((ax === 6 && ay === 6) || (ax === 6 && ay === size - 7) || (ax === size - 7 && ay === 6)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }

    const drawFormat = (mask) => {
      const d = (EC_LEVEL_M << 3) | mask;
      let rem = d;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const f = ((d << 10) | rem) ^ 0x5412;
      const bit = (i) => ((f >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    drawFormat(0); // reserve the format area

    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const v = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((v >>> i) & 1) === 1;
        const a = size - 11 + (i % 3), b = Math.floor(i / 3);
        set(a, b, dark); set(b, a, dark);
      }
    }

    // data in the zig-zag order
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!fn[y][x] && i < final.length * 8) {
            mods[y][x] = ((final[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
            i++;
          }
        }
      }
    }

    const MASKS = [
      (x, y) => (x + y) % 2 === 0,
      (x, y) => y % 2 === 0,
      (x, y) => x % 3 === 0,
      (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
      (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
      (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ];
    const applyMask = (m) => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mods[y][x] = !mods[y][x];
    };

    let best = 0, bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      if (forceMask >= 0 && m !== forceMask) continue;
      applyMask(m);
      drawFormat(m);
      const s = penalty(mods, size);
      if (s < bestScore) { bestScore = s; best = m; }
      applyMask(m); // undo
    }
    applyMask(best);
    drawFormat(best);

    return { version, size, mask: best, get: (x, y) => mods[y][x], modules: mods };
  }

  function penalty(m, n) {
    let score = 0;
    // rule 1: runs of 5+ same colour in rows and columns
    // rules 1 and 3: runs of the same colour, and finder-like 1:1:3:1:1 patterns
    // (light quiet zone counted at both ends, as the standard describes)
    const addHistory = (len, hist) => {
      if (hist[0] === 0) len += n;
      hist.pop();
      hist.unshift(len);
    };
    const countPatterns = (hist) => {
      const k = hist[1];
      const core = k > 0 && hist[2] === k && hist[3] === k * 3 && hist[4] === k && hist[5] === k;
      return (core && hist[0] >= k * 4 && hist[6] >= k ? 1 : 0) + (core && hist[6] >= k * 4 && hist[0] >= k ? 1 : 0);
    };
    for (const horizontal of [true, false]) {
      for (let a = 0; a < n; a++) {
        let color = false, run = 0;
        const hist = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < n; b++) {
          const c = horizontal ? m[a][b] : m[b][a];
          if (c === color) {
            run++;
            if (run === 5) score += 3;
            else if (run > 5) score++;
          } else {
            addHistory(run, hist);
            if (!color) score += countPatterns(hist) * 40;
            color = c;
            run = 1;
          }
        }
        if (color) { addHistory(run, hist); run = 0; }
        addHistory(run + n, hist);
        score += countPatterns(hist) * 40;
      }
    }
    // rule 2: 2x2 blocks
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
      }
    }
    // rule 4: balance of dark and light
    let dark = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) dark++;
    score += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
    return score;
  }

  function toSvg(qr, { border = 4, dark = '#0e1320', light = '#ffffff' } = {}) {
    const n = qr.size + border * 2;
    let d = '';
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) if (qr.get(x, y)) d += `M${x + border},${y + border}h1v1h-1z`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
  }

  const api = { encode, toSvg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QR = api;
})(typeof self !== 'undefined' ? self : this);
