// Streaming front of the markdown renderer.
//
// push() takes raw text deltas in any chunking (even in the middle of a surrogate pair or of "**"); the finished
// lines come out through onLines in order and are never repeated, and what is still pending (the unfinished part of
// the last line) goes to onPartial as ONE string, "\n"-separated when more than one row is pending, "" to clear.
// The concatenation of every onLines call is exactly renderMarkdown(wholeText, { width, dir, indent }) for any
// chunking, as long as the width does not change in between (a width change only affects lines not yet committed).
//
// Decisions:
//  - A growing paragraph line releases its finished rows early (see earlyPara in markdown.js); headings, list items,
//    quote lines and table rows wait for their source line; code lines are released one by one; tables wait for their end.
//  - finish() flushes everything, including an unterminated fence, and clears the partial. reset() starts a new
//    document (blank-line bookkeeping included); after finish() without reset() the stream continues the document.
import { createEngine, splitLines } from "./markdown.js";

const CR = 13;

/**
 * createMarkdownStream({ getWidth, indent = "", dir = "auto", onLines, onPartial }) -> { push(delta), finish(), reset() }
 */
export function createMarkdownStream({ getWidth, indent = "", dir = "auto", onLines, onPartial }) {
  const engine = createEngine({ getWidth: getWidth || (() => 80), indent, dir });
  let buf = "";
  let lastTail = "";

  const commit = lines => { if (lines.length && onLines) onLines(lines); };
  const setTail = tail => {
    if (tail === lastTail) return;
    lastTail = tail;
    if (onPartial) onPartial(tail);
  };

  function push(delta) {
    if (delta === undefined || delta === null || delta === "") return;
    // The buffer holds no complete line, so only the new text (and a trailing CR waiting for its LF) is searched.
    const known = buf.length && buf.charCodeAt(buf.length - 1) === CR ? buf.length - 1 : buf.length;
    buf += String(delta);
    const { lines, rest } = splitLines(buf, known);
    buf = rest;
    const out = [];
    for (const l of lines) for (const r of engine.line(l)) out.push(r);
    const p = engine.partial(buf);
    for (const r of p.lines) out.push(r);
    commit(out);
    setTail(p.tail);
  }

  function finish() {
    const out = engine.finish(buf);
    buf = "";
    commit(out);
    setTail("");
  }

  function reset() {
    engine.reset();
    buf = "";
    setTail("");
  }

  return { push, finish, reset };
}
