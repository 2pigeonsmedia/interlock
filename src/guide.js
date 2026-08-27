'use strict';

const GUIDE_MARKER = '<!-- INTERLOCK_GUIDE_CONTENT -->';
const TOKEN_OPEN = '\u{e000}';
const TOKEN_CLOSE = '\u{e001}';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeReference(value) {
  if (typeof value !== 'string' ||
      !/^(?:\/[A-Za-z0-9._~%/#-]+|(?:\.\.?\/)?[A-Za-z0-9][A-Za-z0-9._~%/#-]*)$/.test(value)) {
    throw new Error('interlock guide: links and images must use local paths');
  }
  return value;
}

function renderTextMarkup(value) {
  return escapeHtml(value)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
}

function renderInline(value) {
  if (value.includes(TOKEN_OPEN) || value.includes(TOKEN_CLOSE)) {
    throw new Error('interlock guide: reserved marker in source');
  }
  const tokens = [];
  function keep(html) {
    const index = tokens.push(html) - 1;
    return `${TOKEN_OPEN}${index}${TOKEN_CLOSE}`;
  }
  let source = value.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_, alt, reference) => {
    const src = escapeHtml(safeReference(reference));
    return keep(`<img src="${src}" alt="${escapeHtml(alt)}" loading="lazy">`);
  });
  source = source.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, reference) => {
    const href = escapeHtml(safeReference(reference));
    return keep(`<a href="${href}">${renderTextMarkup(label)}</a>`);
  });
  let html = renderTextMarkup(source);
  for (let index = 0; index < tokens.length; index += 1) {
    html = html.replace(`${TOKEN_OPEN}${index}${TOKEN_CLOSE}`, tokens[index]);
  }
  return html;
}

function headingSlug(value, used) {
  const root = value
    .replace(/[`*_]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'section';
  const count = (used.get(root) || 0) + 1;
  used.set(root, count);
  return count === 1 ? root : `${root}-${count}`;
}

function renderGuideMarkdown(markdown) {
  if (typeof markdown !== 'string' || markdown.includes('\0')) {
    throw new TypeError('interlock guide: markdown must be text without null bytes');
  }
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  const headings = [];
  const usedSlugs = new Map();
  let paragraph = [];
  let list = null;
  let code = null;

  function closeParagraph() {
    if (paragraph.length === 0) return;
    output.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  }
  function closeList() {
    if (list === null) return;
    output.push(`</${list}>`);
    list = null;
  }
  function closeFlow() {
    closeParagraph();
    closeList();
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (code !== null) {
      if (/^```\s*$/.test(trimmed)) {
        output.push(`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
        code = null;
      } else {
        const contentIndent = rawLine.search(/\S|$/);
        code.lines.push(rawLine.slice(Math.min(code.indent, contentIndent)));
      }
      continue;
    }

    const fence = /^(\s*)```(?:text)?\s*$/.exec(rawLine);
    if (fence) {
      closeFlow();
      code = { indent: fence[1].length, lines: [] };
      continue;
    }
    if (trimmed === '') {
      closeFlow();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      closeFlow();
      const level = heading[1].length;
      const id = headingSlug(heading[2], usedSlugs);
      output.push(`<h${level} id="${id}">${renderInline(heading[2])}</h${level}>`);
      if (level === 2) headings.push(Object.freeze({ id, text: heading[2] }));
      continue;
    }
    if (trimmed === '---') {
      closeFlow();
      output.push('<hr>');
      continue;
    }
    const ordered = /^\s*\d+\.\s+(.+)$/.exec(rawLine);
    const unordered = /^\s*-\s+(.+)$/.exec(rawLine);
    if (ordered || unordered) {
      closeParagraph();
      const kind = ordered ? 'ol' : 'ul';
      if (list !== kind) {
        closeList();
        output.push(`<${kind}>`);
        list = kind;
      }
      output.push(`<li>${renderInline((ordered || unordered)[1])}</li>`);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      closeFlow();
      output.push(`<blockquote><p>${renderInline(quote[1])}</p></blockquote>`);
      continue;
    }
    closeList();
    paragraph.push(trimmed);
  }
  if (code !== null) throw new Error('interlock guide: unclosed code fence');
  closeFlow();
  return Object.freeze({
    headings: Object.freeze(headings),
    html: output.join('\n'),
  });
}

function renderGuidePage(markdown, shell) {
  if (typeof shell !== 'string' || shell.split(GUIDE_MARKER).length !== 2) {
    throw new Error('interlock guide: Help shell must contain exactly one guide marker');
  }
  const rendered = renderGuideMarkdown(markdown);
  const links = rendered.headings
    .map(heading => `<a href="#${heading.id}">${renderInline(heading.text)}</a>`)
    .join('\n');
  const nav = `<nav class="help-nav" aria-label="On this page">\n${links}\n</nav>`;
  const firstHeadingEnd = rendered.html.indexOf('</h1>');
  const content = firstHeadingEnd === -1
    ? `${nav}\n${rendered.html}`
    : `${rendered.html.slice(0, firstHeadingEnd + 5)}\n${nav}${rendered.html.slice(firstHeadingEnd + 5)}`;
  return shell.replace(GUIDE_MARKER, content);
}

module.exports = Object.freeze({
  GUIDE_MARKER,
  renderGuideMarkdown,
  renderGuidePage,
});
