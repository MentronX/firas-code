// HTML -> readable text with light markdown (headings, lists, links, code, quotes, tables). A forgiving
// scanner, not a parser: it never throws on broken markup.
const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "—", ndash: "–", laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  bull: "•", middot: "·", euro: "€", pound: "£", yen: "¥", cent: "¢", times: "×", divide: "÷",
  deg: "°", plusmn: "±", larr: "←", rarr: "→", uarr: "↑", darr: "↓", check: "✓", sect: "§", para: "¶",
};

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try { return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ""; } catch { return ""; }
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

const DROP_WHOLE = /<(script|style|noscript|template|svg|iframe|canvas|nav|head|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCKS = new Set(["p", "div", "section", "article", "header", "main", "aside", "footer", "ul", "ol", "dl", "table", "thead", "tbody", "tfoot", "tr", "figure", "figcaption", "details", "summary", "form", "fieldset", "address", "body", "html", "center", "dd", "dt"]);
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;

function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : "";
}

function resolveLink(href, base) {
  const h = href.trim();
  if (!h || h.startsWith("#") || /^(javascript|data|vbscript):/i.test(h)) return "";
  try { return new URL(h, base).href; } catch { return ""; }
}

/** Returns { title, text }. */
export function htmlToText(html, baseUrl = "") {
  let source = String(html).replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<!doctype[^>]*>/gi, "");
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";
  source = source.replace(DROP_WHOLE, " ").replace(/<(script|style)\b[\s\S]*$/i, " ");
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(source);
  if (main && main[2].replace(/<[^>]*>/g, "").trim().length >= 200) source = main[2];

  let out = "";
  let atLineStart = true;
  let quote = 0;
  let pre = 0;
  const lists = []; // { ordered, n }
  const links = []; // { href, at }
  let skipDepth = 0;

  const prefix = () => "> ".repeat(quote) + "  ".repeat(Math.max(0, lists.length - 1));
  const newline = (count = 1) => {
    if (!out) return;
    out = out.replace(/[ \t]+$/, "");
    const have = /\n*$/.exec(out)[0].length;
    if (have < count) out += "\n".repeat(count - have);
    atLineStart = true;
  };
  const emit = text => {
    if (!text) return;
    if (atLineStart) { out += prefix(); atLineStart = false; }
    out += text;
  };
  const emitText = raw => {
    if (pre) {
      const lines = decodeEntities(raw).split("\n");
      lines.forEach((line, i) => { if (i > 0) { out += "\n"; atLineStart = true; } if (line) emit(line); });
      return;
    }
    let text = decodeEntities(raw).replace(/\s+/g, " ");
    if (atLineStart || /\s$/.test(out)) text = text.replace(/^ /, "");
    if (text) emit(text);
  };

  let last = 0;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(source); m; m = TAG.exec(source)) {
    if (m.index > last && !skipDepth) emitText(source.slice(last, m.index));
    last = TAG.lastIndex;
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3];
    if (skipDepth) { if (tag === "button" && closing) skipDepth = 0; continue; }

    if (/^h[1-6]$/.test(tag)) {
      if (closing) newline(2);
      else { newline(2); emit("#".repeat(Number(tag[1])) + " "); }
    } else if (tag === "br") {
      out += "\n"; atLineStart = true;
    } else if (tag === "hr") {
      newline(2); emit("---"); newline(2);
    } else if (tag === "p" || tag === "blockquote" || tag === "pre") {
      if (tag === "blockquote") { if (closing) quote = Math.max(0, quote - 1); else { newline(1); quote++; } }
      if (tag === "pre") {
        if (closing) { pre = Math.max(0, pre - 1); newline(1); emit("```"); newline(2); }
        else { newline(2); emit("```"); newline(1); pre++; }
      } else newline(2);
    } else if (tag === "ul" || tag === "ol") {
      if (closing) { lists.pop(); newline(lists.length ? 1 : 2); } else { newline(lists.length ? 1 : 2); lists.push({ ordered: tag === "ol", n: 0 }); }
    } else if (tag === "li") {
      if (!closing) {
        newline(1);
        const list = lists[lists.length - 1] || { ordered: false, n: 0 };
        list.n++;
        emit(list.ordered ? `${list.n}. ` : "- ");
      } else newline(1);
    } else if (tag === "a") {
      if (closing) {
        const link = links.pop();
        if (link) {
          const text = out.slice(link.at).replace(/\s+/g, " ").trim();
          if (link.href && text && text !== link.href) out = `${out.slice(0, link.at)}[${text}](${link.href})`;
        }
      } else links.push({ href: resolveLink(attr(attrs, "href"), baseUrl), at: out.length + (atLineStart ? prefix().length : 0) });
    } else if (tag === "code" || tag === "kbd" || tag === "samp") {
      if (!pre) emit("`");
    } else if (tag === "strong" || tag === "b") {
      emit("**");
    } else if (tag === "em" || tag === "i") {
      emit("*");
    } else if (tag === "img") {
      const alt = attr(attrs, "alt").trim();
      if (alt) emit(`[image: ${alt}]`);
    } else if (tag === "td" || tag === "th") {
      if (closing) emit(" | ");
    } else if (tag === "tr") {
      if (closing) { out = out.replace(/ \| $/, ""); newline(1); } else newline(1);
    } else if (tag === "button" && !closing) {
      skipDepth = 1;
    } else if (BLOCKS.has(tag) || tag === "dd" || tag === "dt") {
      newline(1);
    }
  }
  if (last < source.length && !skipDepth) emitText(source.slice(last));

  const text = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text };
}
