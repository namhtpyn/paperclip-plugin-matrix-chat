/**
 * Minimal Markdown -> Matrix HTML renderer (org.matrix.custom.html).
 * Zero dependencies. Covers what agent replies typically use: headings,
 * paragraphs, bullet/numbered lists, blockquotes, fenced code, inline code,
 * bold, italic, strikethrough, links and horizontal rules. All text is
 * HTML-escaped first, so raw HTML in the source is shown literally.
 */

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const SAFE_URL = /^(https?:|mailto:|matrix:|mxc:)/i;

/** Render inline markup on a single (unescaped) line of text. */
export function renderInline(src: string): string {
  // Pull out inline code spans first so their content is not formatted.
  const codes: string[] = [];
  let s = src.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t, code: string) => {
    codes.push(`<code>${escapeHtml(code.trim() === "" ? code : code.replace(/^ (.*) $/, "$1"))}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // Links before escaping so we can validate the raw URL.
  const links: string[] = [];
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => {
    if (!SAFE_URL.test(url)) return m;
    links.push(`<a href="${escapeHtml(url)}">${renderEmphasis(escapeHtml(text))}</a>`);
    return `\u0001${links.length - 1}\u0001`;
  });
  s = renderEmphasis(escapeHtml(s));
  s = s.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => links[Number(i)]);
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
  return s;
}

function renderEmphasis(s: string): string {
  return s
    .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
}

type ListKind = "ul" | "ol";

/** Render a Markdown document to Matrix-safe HTML. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { kind: ListKind; items: string[]; start: number } | null = null;
  let quote: string[] = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(renderInline).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const start = list.kind === "ol" && list.start !== 1 ? ` start="${list.start}"` : "";
    out.push(`<${list.kind}${start}>${list.items.map((i) => `<li>${renderInline(i)}</li>`).join("")}</${list.kind}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${markdownToHtml(quote.join("\n"))}</blockquote>`);
    quote = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/);
    if (fence) {
      flushAll();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      const cls = fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }
    flushQuote();

    if (line.trim() === "") { flushPara(); flushList(); continue; }

    const h = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { flushAll(); out.push(`<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`); continue; }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushAll(); out.push("<hr>"); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const kind: ListKind = ul ? "ul" : "ol";
      if (!list || list.kind !== kind) { flushList(); list = { kind, items: [], start: ol ? Number(ol[1]) : 1 }; }
      list.items.push(ul ? ul[1] : ol![2]);
      continue;
    }

    // Continuation of a list item (indented line directly after an item).
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += " " + line.trim(); continue; }

    flushList();
    para.push(line.trim());
  }
  flushAll();
  return out.join("");
}

/** True when the text contains Markdown worth rendering (avoids HTML for plain replies). */
export function hasMarkdown(text: string): boolean {
  return /(\*\*|__|~~|`|^\s*#{1,6}\s|^\s*[-*+]\s|^\s*\d+[.)]\s|^\s*>|\[[^\]]+\]\([^)]+\)|(^|\W)[*_]\S)/m.test(text);
}
