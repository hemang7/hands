/**
 * In-page element indexer. Runs inside each frame via frame.evaluate().
 *
 * It must be self-contained (no imports, no closures over Node scope). It returns plain records
 * and stashes the live element references on window.__hands so the surface can turn a ref back
 * into an element handle without relying on ids or test attributes.
 *
 * Heuristics are tuned for legacy, table-based server-rendered UIs:
 *   - accessible name falls back to the *anchor*: the text in the previous <td> or the cell above,
 *     which is how a human reads "Member Number [____]" in a table layout
 *   - text-bearing cells are indexed too, so data can be extracted from "label | value" rows
 */
export interface IndexerResult {
  elements: Array<{
    ref: number;
    role: string;
    name: string;
    text: string;
    anchor?: string;
    tag: string;
    attrs: { name?: string; type?: string; value?: string; href?: string; placeholder?: string };
    cssPath: string;
    bbox: { x: number; y: number; w: number; h: number };
    enabled: boolean;
    editable: boolean;
    options?: string[];
    grid?: { colHeader?: string; rowCells: string[] };
  }>;
  text: string;
}

/** Browser-side source. Kept as a string so no bundler helper (e.g. esbuild's __name) leaks into page context. */
export const INDEXER_SOURCE = String.raw`(() => {
  const w = window;
  const out = { elements: [], text: '' };
  const handles = [];
  const MAX_TEXT = 120;

  const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const trunc = (s) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s);

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }

  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur.tagName !== 'HTML') {
      let seg = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(seg);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function cellText(td) {
    if (!td) return '';
    // Only treat a cell as a label if it contains no controls of its own.
    if (td.querySelector('input,select,textarea,button,a')) return '';
    return norm(td.textContent);
  }

  function anchorFor(el) {
    // Inline value inside prose ("Host confirmation number <b>HC123</b>"): the words just before it.
    if (['B', 'SPAN', 'STRONG', 'FONT'].includes(el.tagName)) {
      const prev = el.previousSibling;
      if (prev && prev.nodeType === 3 && norm(prev.textContent)) {
        const clause = norm(prev.textContent).split(/[.:;!?]\s+/).pop() || '';
        const words = clause.replace(/[.:]+$/, '').split(' ');
        return trunc(words.slice(-5).join(' '));
      }
    }
    const td = el.closest('td,th');
    if (!td) return undefined;
    // previous cell in the same row
    let prev = td.previousElementSibling;
    while (prev) {
      const t = cellText(prev);
      if (t) return trunc(t);
      prev = prev.previousElementSibling;
    }
    // cell above in the same column
    const tr = td.parentElement;
    const idx = tr ? Array.from(tr.children).indexOf(td) : -1;
    const prevRow = tr ? tr.previousElementSibling : null;
    if (prevRow && idx >= 0 && prevRow.children[idx]) {
      const t = cellText(prevRow.children[idx]);
      if (t) return trunc(t);
    }
    return undefined;
  }

  // Table-grid context for a cell: its column header (first row of the table, same column index)
  // and the text of the other leaf cells in its row. Lets a recorded extraction say
  // "the 'Current Balance' column of the 'Share Savings' row" instead of "the cell that said $4,812.33".
  function gridFor(el) {
    const td = el.closest('td,th');
    if (!td) return undefined;
    const tr = td.parentElement;
    const table = td.closest('table');
    if (!tr || !table) return undefined;
    const idx = Array.from(tr.children).indexOf(td);
    const rows = Array.from(table.rows ? table.rows : []).filter((r) => r.closest('table') === table);
    if (rows.length < 2 || idx < 0) return undefined;
    const header = rows[0] !== tr && rows[0].children[idx] ? cellText(rows[0].children[idx]) : '';
    const rowCells = Array.from(tr.children).filter((c) => c !== td).map((c) => cellText(c)).filter((t) => t && t.length <= 60);
    if (!header && rowCells.length === 0) return undefined;
    return { colHeader: header || undefined, rowCells };
  }

  function labelFor(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return norm(aria);
    const id = el.getAttribute('id');
    if (id) {
      const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (lab) return norm(lab.textContent);
    }
    const wrap = el.closest('label');
    if (wrap) return norm(wrap.textContent);
    return '';
  }

  function roleOf(el) {
    const tag = el.tagName.toLowerCase();
    const explicit = el.getAttribute('role');
    if (explicit) return { role: explicit, editable: false };
    if (tag === 'a' && el.hasAttribute('href')) return { role: 'link', editable: false };
    if (tag === 'button') return { role: 'button', editable: false };
    if (tag === 'select') return { role: 'combobox', editable: true };
    if (tag === 'textarea') return { role: 'textbox', editable: true };
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image'].includes(t)) return { role: 'button', editable: false };
      if (t === 'checkbox') return { role: 'checkbox', editable: true };
      if (t === 'radio') return { role: 'radio', editable: true };
      if (t === 'password') return { role: 'password', editable: true };
      if (t === 'hidden') return { role: 'other', editable: false };
      return { role: 'textbox', editable: true };
    }
    if (/^h[1-6]$/.test(tag)) return { role: 'heading', editable: false };
    if (tag === 'td' || tag === 'th') return { role: 'cell', editable: false };
    if (el.onclick || el.hasAttribute('onclick')) return { role: 'button', editable: false };
    return { role: 'text', editable: false };
  }

  function nameOf(el, role, anchor) {
    const tag = el.tagName.toLowerCase();
    if (role === 'button' && tag === 'input') {
      return norm(el.getAttribute('value')) || norm(el.getAttribute('title')) || anchor || '';
    }
    if (role === 'link' || role === 'button' || role === 'heading') {
      return norm(el.innerText || el.textContent) || norm(el.getAttribute('title')) || anchor || '';
    }
    if (role === 'cell' || role === 'text') return norm(el.innerText || el.textContent);
    const lab = labelFor(el);
    if (lab) return lab;
    const ph = el.getAttribute('placeholder');
    if (ph) return norm(ph);
    const title = el.getAttribute('title');
    if (title) return norm(title);
    return anchor || '';
  }

  // Interactive controls first, then leaf text cells (for extraction + anchors).
  const controls = Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[role],[onclick]'));
  const cells = Array.from(document.querySelectorAll('td,th,h1,h2,h3,h4,b,font')).filter((c) => {
    // leaf-ish: no nested table or control, has own text
    if (c.querySelector('table,input,select,textarea,button,a')) return false;
    const t = norm(c.textContent);
    if (!t) return false;
    // skip if an ancestor in the list already represents the same text (avoid td > font dupes)
    const p = c.parentElement;
    if (p && ['TD', 'TH', 'B', 'FONT'].includes(p.tagName) && norm(p.textContent) === t) return false;
    return true;
  });

  const seen = new Set();
  for (const el of [...controls, ...cells]) {
    if (seen.has(el) || !isVisible(el)) continue;
    seen.add(el);
    const { role, editable } = roleOf(el);
    if (role === 'other') continue;
    const anchor = anchorFor(el);
    const r = el.getBoundingClientRect();
    const attrs = {};
    for (const a of ['name', 'type', 'value', 'href', 'placeholder']) {
      const v = el.getAttribute(a);
      if (v != null) attrs[a] = a === 'value' && role === 'password' ? '••••' : trunc(norm(v));
    }
    if (el.tagName === 'INPUT' && editable && role !== 'password') attrs.value = trunc(el.value);
    const rec = {
      ref: handles.length,
      role,
      name: trunc(nameOf(el, role, anchor)),
      text: trunc(norm(el.innerText ?? el.textContent)),
      anchor,
      tag: el.tagName.toLowerCase(),
      attrs,
      cssPath: cssPath(el),
      bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      enabled: !el.disabled,
      editable,
    };
    if (el.tagName === 'SELECT') rec.options = Array.from(el.options).map((o) => norm(o.textContent));
    if (role === 'cell') rec.grid = gridFor(el);
    handles.push(el);
    out.elements.push(rec);
  }
  w.__hands = handles;
  out.text = norm(document.body ? document.body.innerText : '').slice(0, 4000);
  return out;
})()`;
