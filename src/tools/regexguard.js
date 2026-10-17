// Guard for the pure-JS fallback of Grep. JavaScript's regular expressions backtrack, so a pattern such as (a+)+$ can
// need years on a line that is not even long, and it runs synchronously: the whole program would freeze. (ripgrep has no
// such problem; this guard only protects the fallback.)
//
// Three layers, cheapest first:
//   1. checkPattern() rejects the shapes that are catastrophic by construction - a repeated group whose body can be
//      split in more than one way: nested repetition (a+)+, (.*)*, a group that may match nothing, alternatives that
//      overlap ((a|ab)*, (\w|\d)+) - with a message that tells the model how to simplify.
//   2. needsGuard() says when a pattern is risky enough that its matching should also run under a hard time limit
//      (grep.js runs it inside node:vm, whose timeout really interrupts a regular expression).
//   3. grep.js caps the pattern length, the length of the line that is scanned, and the total time.
// The shape check is a heuristic on purpose: a pattern it lets through is still stopped by layer 2/3, and a pattern it
// refuses can be rewritten with the hints in the message.

export const PATTERN_MAX = 1000;

// A repetition counts as unbounded from this many repeats on.
const many = max => max > 20;

// Characters used to tell whether two pieces of a pattern can match the same character.
const SAMPLES = (() => {
  const out = ["\t", "\n", "\r"];
  for (let code = 32; code <= 126; code++) out.push(String.fromCharCode(code));
  out.push("é", "ب", "中", " ", " ");
  return out;
})();

// ---------------------------------------------------------------------------------------------------
// A small parser: just enough of the syntax to see groups, alternatives and repetitions.

function parse(source) {
  let i = 0;
  const fail = () => { throw new Error("unparsed"); };

  function parseAlternatives(depth) {
    const alternatives = [[]];
    while (i < source.length) {
      const c = source[i];
      if (c === ")") { if (depth === 0) fail(); break; }
      if (c === "|") { i++; alternatives.push([]); continue; }
      alternatives[alternatives.length - 1].push(parseItem(depth));
    }
    return alternatives;
  }

  function parseClass() {
    let j = i + 1;
    while (j < source.length && source[j] !== "]") j += source[j] === "\\" ? 2 : 1;
    if (j >= source.length) fail();
    const text = source.slice(i, j + 1);
    i = j + 1;
    return { kind: "atom", src: text };
  }

  function parseEscape() {
    const next = source[i + 1];
    if (next === undefined) fail();
    let text;
    if (next === "u" && source[i + 2] === "{") { const close = source.indexOf("}", i); if (close === -1) fail(); text = source.slice(i, close + 1); }
    else if (next === "u") text = source.slice(i, i + 6);
    else if (next === "x") text = source.slice(i, i + 4);
    else if (next === "c") text = source.slice(i, i + 3);
    else if ((next === "p" || next === "P") && source[i + 2] === "{") { const close = source.indexOf("}", i); if (close === -1) fail(); text = source.slice(i, close + 1); }
    else if (next === "k" && source[i + 2] === "<") { const close = source.indexOf(">", i); if (close === -1) fail(); text = source.slice(i, close + 1); }
    else text = source.slice(i, i + 2);
    i += text.length;
    if (next === "b" || next === "B") return { kind: "zero", src: text };
    if (/^\\([1-9]|k<)/.test(text)) return { kind: "backref", src: text };
    return { kind: "atom", src: text };
  }

  function parseQuantifier(item) {
    const c = source[i];
    if (c === "*") { item.min = 0; item.max = Infinity; i++; }
    else if (c === "+") { item.min = 1; item.max = Infinity; i++; }
    else if (c === "?") { item.min = 0; item.max = 1; i++; }
    else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i, i + 24));
      if (!m) return;
      item.min = Number(m[1]);
      item.max = m[2] === undefined ? item.min : m[3] === "" ? Infinity : Number(m[3]);
      i += m[0].length;
    } else return;
    if (source[i] === "?") i++; // lazy
  }

  function parseItem(depth) {
    const c = source[i];
    let item;
    if (c === "(") {
      i++;
      let group = "capture";
      if (source[i] === "?") {
        if (source[i + 1] === ":") { group = "plain"; i += 2; }
        else if (source[i + 1] === "=" || source[i + 1] === "!") { group = "look"; i += 2; }
        else if (source[i + 1] === "<" && (source[i + 2] === "=" || source[i + 2] === "!")) { group = "look"; i += 3; }
        else if (source[i + 1] === "<") { const close = source.indexOf(">", i); if (close === -1) fail(); i = close + 1; }
        else fail();
      }
      const alternatives = parseAlternatives(depth + 1);
      if (source[i] !== ")") fail();
      i++;
      item = { kind: "group", group, alternatives };
    } else if (c === "[") item = parseClass();
    else if (c === "\\") item = parseEscape();
    else if (c === "^" || c === "$") { item = { kind: "zero", src: c }; i++; }
    else if (c === "*" || c === "+" || c === "?") fail();
    else { const ch = String.fromCodePoint(source.codePointAt(i)); item = { kind: "atom", src: ch }; i += ch.length; }
    item.min = 1;
    item.max = 1;
    if (item.kind !== "zero") parseQuantifier(item);
    // A lookaround matches no text of its own, whatever follows it.
    if (item.kind === "group" && item.group === "look") item.min = 0;
    return item;
  }

  const tree = parseAlternatives(0);
  if (i < source.length) fail();
  return tree;
}

// ---------------------------------------------------------------------------------------------------
// Which characters can a piece of pattern consume

function makeMatcher(flags) {
  const cache = new Map();
  const compile = src => {
    if (!cache.has(src)) {
      let re = null;
      // The unicode flag first: without it \p{L} and friends would mean something else.
      try { re = new RegExp(`^(?:${src})$`, flags + "u"); } catch {
        try { re = new RegExp(`^(?:${src})$`, flags); } catch { re = null; }
      }
      cache.set(src, re);
    }
    return cache.get(src);
  };
  // An atom that cannot be compiled alone, or a back-reference, is treated as able to match anything.
  return (item, char) => {
    if (item.kind === "backref") return true;
    const re = compile(item.src);
    return re ? re.test(char) : true;
  };
}

const isLook = item => item.kind === "group" && item.group === "look";

const atomsOf = item => (item.kind === "group" ? (isLook(item) ? [] : item.alternatives.flat().flatMap(atomsOf)) : item.kind === "zero" ? [] : [item]);

function firstAtoms(sequence) {
  const out = [];
  for (const item of sequence) {
    if (item.kind === "zero" || isLook(item)) continue;
    if (item.kind === "group") for (const alt of item.alternatives) out.push(...firstAtoms(alt));
    else out.push(item);
    if (item.min > 0 && !nullableItem(item)) break;
  }
  return out;
}

function nullableItem(item) {
  if (item.kind === "zero") return true;
  if (item.min === 0) return true;
  return item.kind === "group" && item.alternatives.some(nullable);
}

const nullable = sequence => sequence.every(nullableItem);

const unboundedIn = item => many(item.max) || (item.kind === "group" && item.alternatives.some(seq => seq.some(unboundedIn)));

// ---------------------------------------------------------------------------------------------------

const WHY = {
  empty: "a repeated group can match nothing at all, so the repetition can be split without end (for example (a*)* or (x?)+)",
  nested: "a repetition inside a repeated group can be split in many ways between the rounds of the outer repetition (for example (a+)+, (.*)* or (\\w+\\s?)*)",
  alternatives: "a repeated group has alternatives that can match the same text (for example (a|a)*, (a|ab)+ or (\\w|\\d)+)",
};

/**
 * Looks for the catastrophic shapes. Returns null when the pattern looks fine (or cannot be analysed: the regular
 * expression constructor then reports the real syntax error), else a short reason.
 */
export function checkPattern(source, { ignoreCase = false } = {}) {
  let tree;
  try { tree = parse(source); } catch { return null; }
  const matches = makeMatcher(ignoreCase ? "i" : "");
  const overlap = (a, b) => a.some(x => b.some(y => SAMPLES.some(ch => matches(x, ch) && matches(y, ch))));
  const fold = text => (text !== null && ignoreCase ? text.toLowerCase() : text);
  // The text an alternative matches when it is nothing but plain characters (\. and \- count as plain), else null.
  const literalText = seq => {
    let text = "";
    for (const it of seq) {
      if (it.kind !== "atom" || it.min !== 1 || it.max !== 1) return null;
      if (it.src.length === 1 && it.src !== ".") text += it.src;
      else if (/^\\[^A-Za-z0-9]$/.test(it.src)) text += it.src[1];
      else return null;
    }
    return text;
  };

  function repeated(group) {
    const alternatives = group.alternatives;
    if (alternatives.some(nullable)) return "empty";
    for (let a = 0; a < alternatives.length; a++) {
      for (let b = a + 1; b < alternatives.length; b++) {
        const x = fold(literalText(alternatives[a]));
        const y = fold(literalText(alternatives[b]));
        if (x !== null && y !== null) { if (x.startsWith(y) || y.startsWith(x)) return "alternatives"; }
        else if (overlap(firstAtoms(alternatives[a]), firstAtoms(alternatives[b]))) return "alternatives";
      }
    }
    for (const sequence of alternatives) {
      for (let k = 0; k < sequence.length; k++) {
        const piece = sequence[k];
        if (!unboundedIn(piece)) continue;
        const reach = atomsOf(piece);
        let delimited = false;
        for (let j = k + 1; j < sequence.length && !delimited; j++) {
          const next = sequence[j];
          if (next.kind === "zero") continue;
          if (overlap(reach, firstAtoms([next]))) return "nested";
          if (!nullableItem(next)) delimited = true;
        }
        // Nothing mandatory follows inside the group: the next round starts right where this one ended.
        if (!delimited && alternatives.some(other => overlap(reach, firstAtoms(other)))) return "nested";
      }
    }
    return null;
  }

  function walk(alternatives) {
    for (const sequence of alternatives) {
      for (const item of sequence) {
        if (item.kind !== "group") continue;
        const inner = walk(item.alternatives);
        if (inner) return inner;
        if (item.group !== "look" && many(item.max)) {
          const why = repeated(item);
          if (why) return WHY[why];
        }
      }
    }
    return null;
  }
  return walk(tree);
}

/**
 * Does matching this pattern deserve a hard time limit? "always": it has repeated groups or back-references, which can
 * blow up on a short line. "long": only open-ended repeats (three or more), which are slow only on a very long line.
 * false: neither.
 */
export function needsGuard(source) {
  let tree;
  try { tree = parse(source); } catch { return "always"; }
  let open = 0;
  let risky = false;
  (function visit(alternatives) {
    for (const sequence of alternatives) {
      for (const item of sequence) {
        if (item.kind === "backref") risky = true;
        if (many(item.max)) open++;
        if (item.kind === "group") {
          if (item.max > 1) risky = true;
          visit(item.alternatives);
        }
      }
    }
  })(tree);
  return risky ? "always" : open >= 3 ? "long" : false;
}
