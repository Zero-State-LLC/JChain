import { escapeHtml } from "./html";

// A small subset of the counsel drafts: headings, lists, tables, quotes, and links.
// Anything else becomes a paragraph. Text is escaped before tags are added.
export function renderMarkdown(markdown: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (line.startsWith("# ")) {
      out.push(`<h1>${inline(line.slice(2).trim())}</h1>`);
      index += 1;
      continue;
    }
    if (line.startsWith("## ")) {
      out.push(`<h2>${inline(line.slice(3).trim())}</h2>`);
      index += 1;
      continue;
    }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith("> ")) {
        quote.push((lines[index] ?? "").slice(2));
        index += 1;
      }
      out.push(`<blockquote><p>${inline(quote.join(" "))}</p></blockquote>`);
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith("|")) {
        const cells = (lines[index] ?? "").split("|").slice(1, -1).map((cell) => cell.trim());
        if (!cells.every((cell) => /^[-: ]+$/.test(cell))) rows.push(cells);
        index += 1;
      }
      out.push(table(rows));
      continue;
    }
    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith("- ")) {
        items.push(`<li>${inline((lines[index] ?? "").slice(2))}</li>`);
        index += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\. /.test(lines[index] ?? "")) {
        items.push(`<li>${inline((lines[index] ?? "").replace(/^\d+\. /, ""))}</li>`);
        index += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim() !== "" && !blockStart(lines[index] ?? "")) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }
  return out.join("");
}

function blockStart(line: string): boolean {
  return line.startsWith("# ")
    || line.startsWith("## ")
    || line.startsWith("> ")
    || line.startsWith("|")
    || line.startsWith("- ")
    || /^\d+\. /.test(line);
}

function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const [head, ...body] = rows;
  const header = (head ?? []).map((cell) => `<th scope="col">${inline(cell)}</th>`).join("");
  const bodyRows = body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("");
  return `<div class="scroll" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr>${header}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
}

function inline(raw: string): string {
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  const parts: string[] = [];
  let last = 0;
  for (const match of raw.matchAll(pattern)) {
    const at = match.index ?? 0;
    parts.push(escapeHtml(raw.slice(last, at)));
    if (match[1] !== undefined && match[2] !== undefined) {
      const href = safeHref(match[2]);
      parts.push(href === null
        ? escapeHtml(match[1])
        : `<a href="${escapeHtml(href)}">${escapeHtml(match[1])}</a>`);
    } else if (match[3] !== undefined) {
      parts.push(`<strong>${escapeHtml(match[3])}</strong>`);
    } else if (match[4] !== undefined) {
      parts.push(`<code>${escapeHtml(match[4])}</code>`);
    }
    last = at + match[0].length;
  }
  parts.push(escapeHtml(raw.slice(last)));
  return parts.join("");
}

function safeHref(url: string): string | null {
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  if (url.startsWith("https://") || url.startsWith("http://")) return url;
  const name = url.toLowerCase();
  if (name.includes("acceptable")) return "/acceptable-use";
  if (name.includes("privacy")) return "/privacy";
  if (name.includes("terms")) return "/terms";
  return null;
}
