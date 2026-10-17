// Unicode Bidirectional Algorithm (UAX #9), implemented from scratch for terminal use.
//
// Covered: paragraph level (P2-P3), explicit embeddings/overrides/isolates (X1-X10, depth 125),
// weak types (W1-W7), bracket pairs (N0, with canonical equivalents U+2329/U+232A ~ U+3008/U+3009),
// neutrals (N1-N2), implicit levels (I1-I2), trailing-whitespace reset (L1) and reordering (L2).
// Mirroring (L4) is provided as a lookup (`mirrorOf`); the caller applies it at odd levels.
//
// Decisions:
//  - The class table is a compact range list approximating DerivedBidiClass.txt for the scripts and symbol blocks
//    that appear in terminal output; anything not listed is L, except combining marks (NSM) and format
//    characters (BN), which are detected with Unicode property escapes.
//  - The caller passes one class per display cluster (a base letter plus its marks), so marks never separate.
//  - Characters removed by rule X9 (embedding controls, BN) are flagged in `removed`; the caller drops them.

export const L = 0, R = 1, AL = 2, EN = 3, ES = 4, ET = 5, AN = 6, CS = 7, NSM = 8, BN = 9, B = 10, S = 11, WS = 12, ON = 13;
export const LRE = 14, LRO = 15, RLE = 16, RLO = 17, PDF = 18, LRI = 19, RLI = 20, FSI = 21, PDI = 22;

// [first, last, class] triples, ascending and non-overlapping. Gaps are L (or NSM/BN by property).
export const BIDI_RANGES = [
  [0x0000, 0x0008, BN], [0x0009, 0x0009, S], [0x000a, 0x000a, B], [0x000b, 0x000b, S], [0x000c, 0x000c, WS], [0x000d, 0x000d, B],
  [0x000e, 0x001b, BN], [0x001c, 0x001e, B], [0x001f, 0x001f, S], [0x0020, 0x0020, WS], [0x0021, 0x0022, ON], [0x0023, 0x0025, ET],
  [0x0026, 0x002a, ON], [0x002b, 0x002b, ES], [0x002c, 0x002c, CS], [0x002d, 0x002d, ES], [0x002e, 0x002f, CS], [0x0030, 0x0039, EN],
  [0x003a, 0x003a, CS], [0x003b, 0x0040, ON], [0x005b, 0x0060, ON], [0x007b, 0x007e, ON], [0x007f, 0x0084, BN], [0x0085, 0x0085, B],
  [0x0086, 0x009f, BN], [0x00a0, 0x00a0, CS], [0x00a1, 0x00a1, ON], [0x00a2, 0x00a5, ET], [0x00a6, 0x00a9, ON], [0x00ab, 0x00ac, ON],
  [0x00ad, 0x00ad, BN], [0x00ae, 0x00af, ON], [0x00b0, 0x00b1, ET], [0x00b2, 0x00b3, EN], [0x00b4, 0x00b4, ON], [0x00b6, 0x00b8, ON],
  [0x00b9, 0x00b9, EN], [0x00bb, 0x00bf, ON], [0x00d7, 0x00d7, ON], [0x00f7, 0x00f7, ON],
  [0x02b9, 0x02ba, ON], [0x02c2, 0x02cf, ON], [0x02d2, 0x02df, ON], [0x02e5, 0x02ed, ON], [0x02ef, 0x02ff, ON], [0x0300, 0x036f, NSM],
  [0x0374, 0x0375, ON], [0x037e, 0x037e, ON], [0x0384, 0x0385, ON], [0x0387, 0x0387, ON], [0x03f6, 0x03f6, ON], [0x0483, 0x0489, NSM],
  [0x058a, 0x058a, ON], [0x058d, 0x058e, ON], [0x058f, 0x058f, ET],
  // Hebrew
  [0x0590, 0x0590, R], [0x0591, 0x05bd, NSM], [0x05be, 0x05be, R], [0x05bf, 0x05bf, NSM], [0x05c0, 0x05c0, R], [0x05c1, 0x05c2, NSM],
  [0x05c3, 0x05c3, R], [0x05c4, 0x05c5, NSM], [0x05c6, 0x05c6, R], [0x05c7, 0x05c7, NSM], [0x05c8, 0x05ff, R],
  // Arabic
  [0x0600, 0x0605, AN], [0x0606, 0x0607, ON], [0x0608, 0x0608, AL], [0x0609, 0x060a, ET], [0x060b, 0x060b, AL], [0x060c, 0x060c, CS],
  [0x060d, 0x060d, AL], [0x060e, 0x060f, ON], [0x0610, 0x061a, NSM], [0x061b, 0x064a, AL], [0x064b, 0x065f, NSM], [0x0660, 0x0669, AN],
  [0x066a, 0x066a, ET], [0x066b, 0x066c, AN], [0x066d, 0x066f, AL], [0x0670, 0x0670, NSM], [0x0671, 0x06d5, AL], [0x06d6, 0x06dc, NSM],
  [0x06dd, 0x06dd, AN], [0x06de, 0x06de, ON], [0x06df, 0x06e4, NSM], [0x06e5, 0x06e6, AL], [0x06e7, 0x06e8, NSM], [0x06e9, 0x06e9, ON],
  [0x06ea, 0x06ed, NSM], [0x06ee, 0x06ef, AL], [0x06f0, 0x06f9, EN],
  // Syriac, Thaana
  [0x06fa, 0x0710, AL], [0x0711, 0x0711, NSM], [0x0712, 0x072f, AL], [0x0730, 0x074a, NSM], [0x074b, 0x07a5, AL], [0x07a6, 0x07b0, NSM],
  [0x07b1, 0x07bf, AL],
  // NKo, Samaritan, Mandaic
  [0x07c0, 0x07ea, R], [0x07eb, 0x07f3, NSM], [0x07f4, 0x07f5, R], [0x07f6, 0x07f9, ON], [0x07fa, 0x07fc, R], [0x07fd, 0x07fd, NSM],
  [0x07fe, 0x0815, R], [0x0816, 0x0819, NSM], [0x081a, 0x081a, R], [0x081b, 0x0823, NSM], [0x0824, 0x0824, R], [0x0825, 0x0827, NSM],
  [0x0828, 0x0828, R], [0x0829, 0x082d, NSM], [0x082e, 0x0858, R], [0x0859, 0x085b, NSM], [0x085c, 0x085f, R],
  // Arabic Extended
  [0x0860, 0x088f, AL], [0x0890, 0x0891, AN], [0x0892, 0x0896, AL], [0x0897, 0x089f, NSM], [0x08a0, 0x08c9, AL], [0x08ca, 0x08e1, NSM],
  [0x08e2, 0x08e2, AN], [0x08e3, 0x08ff, NSM],
  [0x09f2, 0x09f3, ET], [0x09fb, 0x09fb, ET], [0x0af1, 0x0af1, ET], [0x0bf3, 0x0bf8, ON], [0x0bf9, 0x0bf9, ET], [0x0bfa, 0x0bfa, ON],
  [0x0c78, 0x0c7e, ON], [0x0cbf, 0x0cbf, L], [0x0cc6, 0x0cc6, L], [0x0e3f, 0x0e3f, ET], [0x0f3a, 0x0f3d, ON], [0x1390, 0x1399, ON],
  [0x1400, 0x1400, ON], [0x1680, 0x1680, WS], [0x169b, 0x169c, ON], [0x17db, 0x17db, ET], [0x17f0, 0x17f9, ON], [0x1800, 0x180a, ON],
  [0x180e, 0x180e, BN], [0x1940, 0x1940, ON], [0x1944, 0x1945, ON], [0x19de, 0x19ff, ON], [0x1fbd, 0x1fbd, ON], [0x1fbf, 0x1fc1, ON],
  [0x1fcd, 0x1fcf, ON], [0x1fdd, 0x1fdf, ON], [0x1fed, 0x1fef, ON], [0x1ffd, 0x1ffe, ON],
  // General punctuation and explicit controls
  [0x2000, 0x200a, WS], [0x200b, 0x200d, BN], [0x200e, 0x200e, L], [0x200f, 0x200f, R], [0x2010, 0x2027, ON], [0x2028, 0x2028, WS], [0x2029, 0x2029, B],
  [0x202a, 0x202a, LRE], [0x202b, 0x202b, RLE], [0x202c, 0x202c, PDF], [0x202d, 0x202d, LRO], [0x202e, 0x202e, RLO], [0x202f, 0x202f, CS],
  [0x2030, 0x2034, ET], [0x2035, 0x2043, ON], [0x2044, 0x2044, CS], [0x2045, 0x205e, ON], [0x205f, 0x205f, WS], [0x2060, 0x2065, BN],
  [0x2066, 0x2066, LRI], [0x2067, 0x2067, RLI], [0x2068, 0x2068, FSI], [0x2069, 0x2069, PDI], [0x206a, 0x206f, BN],
  [0x2070, 0x2070, EN], [0x2074, 0x2079, EN], [0x207a, 0x207b, ES], [0x207c, 0x207e, ON], [0x2080, 0x2089, EN], [0x208a, 0x208b, ES],
  [0x208c, 0x208e, ON], [0x20a0, 0x20cf, ET], [0x20d0, 0x20ff, NSM],
  // Letterlike, number forms, arrows, mathematical operators, technical, shapes, dingbats
  [0x2100, 0x2101, ON], [0x2103, 0x2106, ON], [0x2108, 0x2109, ON], [0x2114, 0x2114, ON], [0x2116, 0x2118, ON], [0x211e, 0x2123, ON],
  [0x2125, 0x2125, ON], [0x2127, 0x2127, ON], [0x2129, 0x2129, ON], [0x212e, 0x212e, ET], [0x213a, 0x213b, ON], [0x2140, 0x2144, ON],
  [0x214a, 0x214d, ON], [0x2150, 0x215f, ON], [0x2189, 0x218b, ON], [0x2190, 0x2211, ON], [0x2212, 0x2212, ES], [0x2213, 0x2213, ET],
  [0x2214, 0x2335, ON], [0x237b, 0x2394, ON], [0x2396, 0x2429, ON], [0x2440, 0x244a, ON], [0x2460, 0x2487, ON], [0x2488, 0x249b, EN],
  [0x24ea, 0x26ab, ON], [0x26ad, 0x27ff, ON], [0x2900, 0x2b73, ON], [0x2b76, 0x2b95, ON], [0x2b97, 0x2bff, ON],
  [0x2ce5, 0x2cea, ON], [0x2cef, 0x2cf1, NSM], [0x2cf9, 0x2cff, ON], [0x2d7f, 0x2d7f, NSM], [0x2de0, 0x2dff, NSM], [0x2e00, 0x2e5d, ON],
  [0x2e80, 0x2e99, ON], [0x2e9b, 0x2ef3, ON], [0x2f00, 0x2fd5, ON], [0x2ff0, 0x2fff, ON],
  // CJK symbols
  [0x3000, 0x3000, WS], [0x3001, 0x3004, ON], [0x3008, 0x3020, ON], [0x302a, 0x302d, NSM], [0x3030, 0x3030, ON], [0x3036, 0x3037, ON],
  [0x303d, 0x303f, ON], [0x3099, 0x309a, NSM], [0x309b, 0x309c, ON], [0x30a0, 0x30a0, ON], [0x30fb, 0x30fb, ON], [0x31c0, 0x31e3, ON], [0x31ef, 0x31ef, ON],
  [0x321d, 0x321e, ON], [0x3250, 0x325f, ON], [0x327c, 0x327e, ON], [0x32b1, 0x32bf, ON], [0x32cc, 0x32cf, ON], [0x3377, 0x337a, ON],
  [0x33de, 0x33df, ON], [0x33ff, 0x33ff, ON], [0x4dc0, 0x4dff, ON], [0xa490, 0xa4c6, ON], [0xa60d, 0xa60f, ON], [0xa66f, 0xa672, NSM],
  [0xa673, 0xa673, ON], [0xa674, 0xa67d, NSM], [0xa67e, 0xa67f, ON], [0xa69e, 0xa69f, NSM], [0xa6f0, 0xa6f1, NSM], [0xa700, 0xa721, ON],
  [0xa788, 0xa788, ON], [0xa828, 0xa82b, ON], [0xa838, 0xa839, ET], [0xa874, 0xa877, ON], [0xab6a, 0xab6b, ON],
  // Hebrew and Arabic presentation forms
  [0xfb1d, 0xfb1d, R], [0xfb1e, 0xfb1e, NSM], [0xfb1f, 0xfb28, R], [0xfb29, 0xfb29, ES], [0xfb2a, 0xfb4f, R], [0xfb50, 0xfd3d, AL],
  [0xfd3e, 0xfd4f, ON], [0xfd50, 0xfdce, AL], [0xfdcf, 0xfdcf, ON], [0xfdd0, 0xfdef, BN], [0xfdf0, 0xfdfc, AL], [0xfdfd, 0xfdff, ON],
  [0xfe00, 0xfe0f, NSM], [0xfe10, 0xfe19, ON], [0xfe20, 0xfe2f, NSM], [0xfe30, 0xfe4f, ON], [0xfe50, 0xfe50, CS], [0xfe51, 0xfe51, ON],
  [0xfe52, 0xfe52, CS], [0xfe54, 0xfe54, ON], [0xfe55, 0xfe55, CS], [0xfe56, 0xfe5e, ON], [0xfe5f, 0xfe5f, ET], [0xfe60, 0xfe61, ON],
  [0xfe62, 0xfe63, ES], [0xfe64, 0xfe66, ON], [0xfe68, 0xfe68, ON], [0xfe69, 0xfe6a, ET], [0xfe6b, 0xfe6b, ON], [0xfe70, 0xfefe, AL],
  [0xfeff, 0xfeff, BN], [0xff01, 0xff02, ON], [0xff03, 0xff05, ET], [0xff06, 0xff0a, ON], [0xff0b, 0xff0b, ES], [0xff0c, 0xff0c, CS],
  [0xff0d, 0xff0d, ES], [0xff0e, 0xff0f, CS], [0xff10, 0xff19, EN], [0xff1a, 0xff1a, CS], [0xff1b, 0xff20, ON], [0xff3b, 0xff40, ON],
  [0xff5b, 0xff65, ON], [0xffe0, 0xffe1, ET], [0xffe2, 0xffe4, ON], [0xffe5, 0xffe6, ET], [0xffe8, 0xffee, ON], [0xfff9, 0xfffd, ON],
  [0xfffe, 0xffff, BN],
  // Right-to-left historic scripts, Arabic-script supplements (astral)
  [0x10101, 0x10101, ON], [0x10140, 0x1018c, ON], [0x10190, 0x1019c, ON], [0x101a0, 0x101a0, ON], [0x102e1, 0x102fb, EN],
  [0x10800, 0x10cff, R], [0x10d00, 0x10d2f, AL], [0x10d30, 0x10d39, AN], [0x10d3a, 0x10e5f, R], [0x10e60, 0x10e7e, AN],
  [0x10e7f, 0x10ebf, R], [0x10ec0, 0x10eff, AL], [0x10f00, 0x10f2f, R], [0x10f30, 0x10f6f, AL], [0x10f70, 0x10fff, R],
  [0x110bd, 0x110bd, L], [0x110cd, 0x110cd, L], [0x13430, 0x1343f, L], [0x1bca0, 0x1bca3, BN], [0x1d173, 0x1d17a, BN], [0x1d7ce, 0x1d7ff, EN],
  [0x1e800, 0x1ec6f, R], [0x1ec70, 0x1ecbf, AL], [0x1ecc0, 0x1ecff, R], [0x1ed00, 0x1ed4f, AL], [0x1ed50, 0x1edff, R],
  [0x1ee00, 0x1eeef, AL], [0x1eef0, 0x1eef1, ON], [0x1eef2, 0x1eeff, AL], [0x1ef00, 0x1efff, R],
  [0x1f000, 0x1f0ff, ON], [0x1f100, 0x1f10a, EN], [0x1f10b, 0x1f10f, ON], [0x1f300, 0x1faff, ON], [0x1fb00, 0x1fbca, ON], [0x1fbf0, 0x1fbf9, EN],
  [0xe0001, 0xe0001, BN], [0xe0020, 0xe007f, BN],
];

const TABLE = new Int32Array(BIDI_RANGES.length * 3);
BIDI_RANGES.forEach((r, i) => { TABLE[i * 3] = r[0]; TABLE[i * 3 + 1] = r[1]; TABLE[i * 3 + 2] = r[2]; });

const RE_NSM = /^[\p{Mn}\p{Me}]$/u;
const RE_CF = /^\p{Cf}$/u;

// Combining marks inside right-to-left blocks are NSM like everywhere else.
function nsmInside(cp, c) {
  return (c === R || c === AL) && cp >= 0x300 && RE_NSM.test(String.fromCodePoint(cp)) ? NSM : c;
}

function lookup(cp) {
  let lo = 0, hi = BIDI_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < TABLE[mid * 3]) hi = mid - 1;
    else if (cp > TABLE[mid * 3 + 1]) lo = mid + 1;
    else return nsmInside(cp, TABLE[mid * 3 + 2]);
  }
  if (cp >= 0x300) {
    const ch = String.fromCodePoint(cp);
    if (RE_NSM.test(ch)) return NSM;
    if (RE_CF.test(ch)) return BN;
  }
  return L;
}

const classCache = new Uint8Array(0x10000); // class + 1 once known
const ASCII = new Uint8Array(128);
for (let i = 0; i < 128; i++) ASCII[i] = lookup(i);

/** Bidi class of one code point (one of the constants above). */
export function bidiClass(cp) {
  if (cp < 0x80) return ASCII[cp];
  if (cp < 0x10000) {
    const v = classCache[cp];
    if (v) return v - 1;
    const c = lookup(cp);
    classCache[cp] = c + 1;
    return c;
  }
  return lookup(cp);
}

// ---------------------------------------------------------------------------------------------
// Mirroring (L4) and bracket pairs (BD14-BD16)

const MIRROR = new Map();
const BRACKET_CLOSE = new Map(); // opening bracket -> closing bracket
const BRACKET_OPEN = new Map();  // closing bracket -> opening bracket

function mirrorPair(a, b) { MIRROR.set(a, b); MIRROR.set(b, a); }
function bracketPair(a, b) { mirrorPair(a, b); BRACKET_CLOSE.set(a, b); BRACKET_OPEN.set(b, a); }

[[0x28, 0x29], [0x5b, 0x5d], [0x7b, 0x7d], [0xf3a, 0xf3b], [0xf3c, 0xf3d], [0x169b, 0x169c], [0x2045, 0x2046], [0x207d, 0x207e],
  [0x208d, 0x208e], [0x2308, 0x2309], [0x230a, 0x230b], [0x2329, 0x232a], [0x2768, 0x2769], [0x276a, 0x276b], [0x276c, 0x276d],
  [0x276e, 0x276f], [0x2770, 0x2771], [0x2772, 0x2773], [0x2774, 0x2775], [0x27c5, 0x27c6], [0x27e6, 0x27e7], [0x27e8, 0x27e9],
  [0x27ea, 0x27eb], [0x27ec, 0x27ed], [0x27ee, 0x27ef], [0x2983, 0x2984], [0x2985, 0x2986], [0x2987, 0x2988], [0x2989, 0x298a],
  [0x298b, 0x298c], [0x298d, 0x2990], [0x298f, 0x298e], [0x2991, 0x2992], [0x2993, 0x2994], [0x2995, 0x2996], [0x2997, 0x2998],
  [0x29d8, 0x29d9], [0x29da, 0x29db], [0x29fc, 0x29fd], [0x2e22, 0x2e23], [0x2e24, 0x2e25], [0x2e26, 0x2e27], [0x2e28, 0x2e29],
  [0x3008, 0x3009], [0x300a, 0x300b], [0x300c, 0x300d], [0x300e, 0x300f], [0x3010, 0x3011], [0x3014, 0x3015], [0x3016, 0x3017],
  [0x3018, 0x3019], [0x301a, 0x301b], [0xfe59, 0xfe5a], [0xfe5b, 0xfe5c], [0xfe5d, 0xfe5e], [0xff08, 0xff09], [0xff3b, 0xff3d],
  [0xff5b, 0xff5d], [0xff5f, 0xff60], [0xff62, 0xff63]].forEach(([a, b]) => bracketPair(a, b));

// Mirrored but not paired (quotation marks, comparison and set operators)
[[0x3c, 0x3e], [0xab, 0xbb], [0x2039, 0x203a], [0x2208, 0x220b], [0x2209, 0x220c], [0x220a, 0x220d], [0x2215, 0x29f5],
  [0x223c, 0x223d], [0x2243, 0x22cd], [0x2252, 0x2253], [0x2254, 0x2255], [0x2264, 0x2265], [0x2266, 0x2267], [0x2268, 0x2269],
  [0x226a, 0x226b], [0x226e, 0x226f], [0x2270, 0x2271], [0x2272, 0x2273], [0x2274, 0x2275], [0x2276, 0x2277], [0x2278, 0x2279],
  [0x227a, 0x227b], [0x227c, 0x227d], [0x227e, 0x227f], [0x2280, 0x2281], [0x2282, 0x2283], [0x2284, 0x2285], [0x2286, 0x2287],
  [0x2288, 0x2289], [0x228a, 0x228b], [0x228f, 0x2290], [0x2291, 0x2292], [0x22a2, 0x22a3], [0x22b0, 0x22b1], [0x22b2, 0x22b3],
  [0x22b4, 0x22b5], [0x22b6, 0x22b7], [0x22c9, 0x22ca], [0x22cb, 0x22cc], [0x22d0, 0x22d1], [0x22d6, 0x22d7], [0x22d8, 0x22d9],
  [0x22da, 0x22db], [0x22dc, 0x22dd], [0x22de, 0x22df], [0x22e0, 0x22e1], [0x22e2, 0x22e3], [0x22e4, 0x22e5], [0x22e6, 0x22e7],
  [0x22e8, 0x22e9], [0x22ea, 0x22eb], [0x22ec, 0x22ed], [0x22f0, 0x22f1], [0x22f2, 0x22fa], [0x22f3, 0x22fb], [0x22f4, 0x22fc],
  [0x22f6, 0x22fd], [0x22f7, 0x22fe], [0x2e02, 0x2e03], [0x2e04, 0x2e05], [0x2e09, 0x2e0a], [0x2e0c, 0x2e0d], [0x2e1c, 0x2e1d],
  [0x2e20, 0x2e21], [0xfe64, 0xfe65], [0xff1c, 0xff1e]].forEach(([a, b]) => mirrorPair(a, b));

/** The glyph to draw for `cp` inside right-to-left text (itself when it has no mirror image). */
export function mirrorOf(cp) {
  const m = MIRROR.get(cp);
  return m === undefined ? cp : m;
}

function canonicalBracket(cp) {
  return cp === 0x2329 ? 0x3008 : cp === 0x232a ? 0x3009 : cp;
}

// ---------------------------------------------------------------------------------------------
// Paragraph direction

/** First strong direction by P2/P3 over code points ("ltr" | "rtl" | null), skipping isolated content. */
export function firstStrongDirection(str) {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp < 0x80) {
      if (depth === 0) {
        if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return "ltr";
      }
      continue;
    }
    if (cp >= 0xd800 && cp < 0xdc00) { cp = str.codePointAt(i); i++; }
    const c = bidiClass(cp);
    if (c === LRI || c === RLI || c === FSI) depth++;
    else if (c === PDI) { if (depth > 0) depth--; }
    else if (depth === 0) {
      if (c === L) return "ltr";
      if (c === R || c === AL) return "rtl";
    }
  }
  return null;
}

function firstStrong(types, start, end, match) {
  for (let i = start; i < end; i++) {
    const t = types[i];
    if (t === L) return 0;
    if (t === R || t === AL) return 1;
    if (t === LRI || t === RLI || t === FSI) {
      if (match[i] === -1) return -1;
      i = match[i];
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Resolution

const MAX_DEPTH = 125;

/**
 * Resolves embedding levels for one paragraph (one display line).
 * `types`: bidi class per element, `cps`: code point per element (for bracket pairing),
 * `dir`: 0 = LTR, 1 = RTL, anything else = detect (P2/P3).
 * Returns { levels, removed, paraLevel }; elements flagged in `removed` (X9) take no part in display.
 */
export function resolveParagraph(types0, cps, dir) {
  const n = types0.length;
  const orig = types0;
  const levels = new Uint8Array(n);
  const removed = new Uint8Array(n);
  if (n === 0) return { levels, removed, paraLevel: dir === 1 ? 1 : 0 };

  const match = new Int32Array(n).fill(-1);
  let needX = false;
  {
    const stack = [];
    for (let i = 0; i < n; i++) {
      const t = orig[i];
      if (t >= LRE || t === BN) needX = true;
      if (t === LRI || t === RLI || t === FSI) stack.push(i);
      else if (t === PDI && stack.length) { const j = stack.pop(); match[j] = i; match[i] = j; }
    }
  }
  let paraLevel = dir === 1 ? 1 : 0;
  if (dir !== 0 && dir !== 1) {
    const f = firstStrong(orig, 0, n, match);
    paraLevel = f === 1 ? 1 : 0;
  }

  const types = Uint8Array.from(orig);

  if (!needX) {
    levels.fill(paraLevel);
  } else {
    const stLevel = new Uint8Array(MAX_DEPTH + 3);
    const stOv = new Uint8Array(MAX_DEPTH + 3); // 0 neutral, 1 L, 2 R
    const stIso = new Uint8Array(MAX_DEPTH + 3);
    let sp = 0;
    stLevel[0] = paraLevel;
    let overIso = 0, overEmb = 0, validIso = 0;
    for (let i = 0; i < n; i++) {
      const t = orig[i];
      if (t === RLE || t === LRE || t === RLO || t === LRO) {
        const cur = stLevel[sp];
        const nl = (t === RLE || t === RLO) ? (cur + 1) | 1 : (cur + 2) & ~1;
        levels[i] = cur;
        removed[i] = 1;
        if (nl <= MAX_DEPTH && overIso === 0 && overEmb === 0) {
          sp++;
          stLevel[sp] = nl;
          stOv[sp] = t === RLO ? 2 : t === LRO ? 1 : 0;
          stIso[sp] = 0;
        } else if (overIso === 0) overEmb++;
      } else if (t === RLI || t === LRI || t === FSI) {
        const cur = stLevel[sp];
        levels[i] = cur;
        if (stOv[sp] === 1) types[i] = L; else if (stOv[sp] === 2) types[i] = R;
        let rtl = t === RLI;
        if (t === FSI) rtl = firstStrong(orig, i + 1, match[i] === -1 ? n : match[i], match) === 1;
        const nl = rtl ? (cur + 1) | 1 : (cur + 2) & ~1;
        if (nl <= MAX_DEPTH && overIso === 0 && overEmb === 0) {
          validIso++;
          sp++;
          stLevel[sp] = nl;
          stOv[sp] = 0;
          stIso[sp] = 1;
        } else overIso++;
      } else if (t === PDI) {
        if (overIso > 0) overIso--;
        else if (validIso > 0) {
          overEmb = 0;
          while (!stIso[sp]) sp--;
          sp--;
          validIso--;
        }
        levels[i] = stLevel[sp];
        if (stOv[sp] === 1) types[i] = L; else if (stOv[sp] === 2) types[i] = R;
      } else if (t === PDF) {
        levels[i] = stLevel[sp];
        removed[i] = 1;
        if (overIso > 0) { /* ignored */ } else if (overEmb > 0) overEmb--;
        else if (!stIso[sp] && sp >= 1) sp--;
      } else if (t === B) {
        levels[i] = paraLevel;
      } else if (t === BN) {
        levels[i] = stLevel[sp];
        removed[i] = 1;
      } else {
        levels[i] = stLevel[sp];
        if (stOv[sp] === 1) types[i] = L; else if (stOv[sp] === 2) types[i] = R;
      }
    }
  }

  // Embedding levels stay readable while implicit levels are written into `levels`.
  const emb = Uint8Array.from(levels);

  // X9: kept elements only
  const keep = [];
  for (let i = 0; i < n; i++) if (!removed[i]) keep.push(i);
  const m = keep.length;
  if (m === 0) return { levels, removed, paraLevel };
  const kOf = new Int32Array(n).fill(-1);
  for (let k = 0; k < m; k++) kOf[keep[k]] = k;

  // X10: level runs and isolating run sequences
  const runStart = [], runEnd = [];
  const runOfK = new Int32Array(m);
  for (let k = 0; k < m; k++) {
    if (k === 0 || emb[keep[k]] !== emb[keep[k - 1]]) runStart.push(k);
    runEnd[runStart.length - 1] = k + 1;
    runOfK[k] = runStart.length - 1;
  }
  for (let r = 0; r < runStart.length; r++) {
    const first = keep[runStart[r]];
    if (orig[first] === PDI && match[first] !== -1) continue; // continues an earlier sequence
    const sq = [];
    let rr = r;
    for (;;) {
      for (let k = runStart[rr]; k < runEnd[rr]; k++) sq.push(keep[k]);
      const last = sq[sq.length - 1];
      const lt = orig[last];
      if ((lt === LRI || lt === RLI || lt === FSI) && match[last] !== -1) rr = runOfK[kOf[match[last]]];
      else break;
    }
    resolveSequence(sq, orig, types, cps, emb, levels, keep, kOf, paraLevel);
  }

  // Removed elements borrow the level of what precedes them.
  let carry = paraLevel;
  for (let i = 0; i < n; i++) {
    if (removed[i]) levels[i] = carry; else carry = levels[i];
  }

  // L1: separators and trailing whitespace go back to the paragraph level.
  let reset = true;
  for (let i = n - 1; i >= 0; i--) {
    if (removed[i]) continue;
    const t = orig[i];
    if (t === S || t === B) { levels[i] = paraLevel; reset = true; }
    else if (reset && (t === WS || t === FSI || t === LRI || t === RLI || t === PDI)) levels[i] = paraLevel;
    else reset = false;
  }
  return { levels, removed, paraLevel };
}

function strongFor(t) {
  // L -> L, R/EN/AN -> R, anything else: not strong (-1)
  if (t === L) return L;
  if (t === R || t === EN || t === AN) return R;
  return -1;
}

function resolveSequence(sq, orig, types, cps, emb, levels, keep, kOf, paraLevel) {
  const len = sq.length;
  const level = emb[sq[0]];
  const firstK = kOf[sq[0]];
  const prevLevel = firstK > 0 ? emb[keep[firstK - 1]] : paraLevel;
  const lastIdx = sq[len - 1];
  const lastK = kOf[lastIdx];
  const lt = orig[lastIdx];
  let nextLevel = paraLevel;
  if (!(lt === LRI || lt === RLI || lt === FSI) && lastK + 1 < keep.length) nextLevel = emb[keep[lastK + 1]];
  const sos = (Math.max(level, prevLevel) & 1) ? R : L;
  const eos = (Math.max(level, nextLevel) & 1) ? R : L;

  const t = new Uint8Array(len);
  for (let i = 0; i < len; i++) t[i] = types[sq[i]];
  const preW = Uint8Array.from(t);

  // W1
  for (let i = 0; i < len; i++) {
    if (t[i] !== NSM) continue;
    if (i === 0) t[i] = sos;
    else {
      const p = t[i - 1];
      t[i] = (p === LRI || p === RLI || p === FSI || p === PDI) ? ON : p;
    }
  }
  // W2
  let strong = sos;
  for (let i = 0; i < len; i++) {
    const x = t[i];
    if (x === L || x === R || x === AL) strong = x;
    else if (x === EN && strong === AL) t[i] = AN;
  }
  // W3
  for (let i = 0; i < len; i++) if (t[i] === AL) t[i] = R;
  // W4
  for (let i = 1; i < len - 1; i++) {
    const x = t[i];
    if (x === ES) { if (t[i - 1] === EN && t[i + 1] === EN) t[i] = EN; }
    else if (x === CS) {
      if (t[i - 1] === EN && t[i + 1] === EN) t[i] = EN;
      else if (t[i - 1] === AN && t[i + 1] === AN) t[i] = AN;
    }
  }
  // W5
  for (let i = 0; i < len; i++) {
    if (t[i] !== ET) continue;
    let j = i;
    while (j < len && t[j] === ET) j++;
    if ((i > 0 && t[i - 1] === EN) || (j < len && t[j] === EN)) for (let k = i; k < j; k++) t[k] = EN;
    i = j - 1;
  }
  // W6
  for (let i = 0; i < len; i++) if (t[i] === ES || t[i] === ET || t[i] === CS) t[i] = ON;
  // W7
  strong = sos;
  for (let i = 0; i < len; i++) {
    const x = t[i];
    if (x === L || x === R) strong = x;
    else if (x === EN && strong === L) t[i] = L;
  }

  resolveBrackets(sq, t, preW, cps, level, sos);

  // N1 / N2
  const embedding = (level & 1) ? R : L;
  for (let i = 0; i < len; i++) {
    const x = t[i];
    if (!(x === ON || x === WS || x === S || x === B || x === LRI || x === RLI || x === FSI || x === PDI)) continue;
    let j = i;
    while (j < len) {
      const y = t[j];
      if (y === ON || y === WS || y === S || y === B || y === LRI || y === RLI || y === FSI || y === PDI) j++; else break;
    }
    const lead = i === 0 ? sos : strongFor(t[i - 1]);
    const trail = j === len ? eos : strongFor(t[j]);
    const dir = lead === trail && lead !== -1 ? lead : embedding;
    for (let k = i; k < j; k++) t[k] = dir;
    i = j - 1;
  }

  // I1 / I2
  for (let i = 0; i < len; i++) {
    const x = t[i];
    let lv = level;
    if ((level & 1) === 0) { if (x === R) lv += 1; else if (x === AN || x === EN) lv += 2; }
    else if (x === L || x === EN || x === AN) lv += 1;
    levels[sq[i]] = lv;
  }
}

function resolveBrackets(sq, t, preW, cps, level, sos) {
  const len = sq.length;
  const stackCp = [], stackPos = [];
  const pairs = [];
  for (let k = 0; k < len; k++) {
    if (t[k] !== ON) continue;
    const cp = cps[sq[k]];
    const closer = BRACKET_CLOSE.get(cp);
    if (closer !== undefined) {
      if (stackCp.length === 63) break;
      stackCp.push(canonicalBracket(closer));
      stackPos.push(k);
    } else if (BRACKET_OPEN.has(cp)) {
      const want = canonicalBracket(cp);
      for (let s = stackCp.length - 1; s >= 0; s--) {
        if (stackCp[s] === want) {
          pairs.push([stackPos[s], k]);
          stackCp.length = s;
          stackPos.length = s;
          break;
        }
      }
    }
  }
  if (!pairs.length) return;
  pairs.sort((a, b) => a[0] - b[0]);
  const e = (level & 1) ? R : L;
  const opposite = e === L ? R : L;
  const setPair = (o, c, dir) => {
    t[o] = dir;
    t[c] = dir;
    for (let k = o + 1; k < len && preW[k] === NSM; k++) t[k] = dir;
    for (let k = c + 1; k < len && preW[k] === NSM; k++) t[k] = dir;
  };
  for (const [o, c] of pairs) {
    let foundE = false, foundO = false;
    for (let k = o + 1; k < c; k++) {
      const s = strongFor(t[k]);
      if (s === e) { foundE = true; break; }
      if (s !== -1) foundO = true;
    }
    if (foundE) { setPair(o, c, e); continue; }
    if (!foundO) continue;
    let ctx = sos;
    for (let k = o - 1; k >= 0; k--) {
      const s = strongFor(t[k]);
      if (s !== -1) { ctx = s; break; }
    }
    setPair(o, c, ctx === opposite ? opposite : e);
  }
}

/** Indexes of the kept elements in visual (left-to-right) order, by rule L2. */
export function visualOrder(levels, removed) {
  const idx = [];
  let max = 0, minOdd = 255;
  for (let i = 0; i < levels.length; i++) {
    if (removed && removed[i]) continue;
    idx.push(i);
    const lv = levels[i];
    if (lv > max) max = lv;
    if ((lv & 1) && lv < minOdd) minOdd = lv;
  }
  if (max === 0) return idx;
  for (let lvl = max; lvl >= minOdd; lvl--) {
    let i = 0;
    while (i < idx.length) {
      if (levels[idx[i]] >= lvl) {
        let j = i + 1;
        while (j < idx.length && levels[idx[j]] >= lvl) j++;
        for (let a = i, b = j - 1; a < b; a++, b--) { const x = idx[a]; idx[a] = idx[b]; idx[b] = x; }
        i = j;
      } else i++;
    }
  }
  return idx;
}
