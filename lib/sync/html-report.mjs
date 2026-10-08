// lib/sync/html-report.mjs
// Pure: render a comparison as one self-contained HTML page (inline CSS and
// script, no external URLs). Every interpolated value is escaped.

const UNCHANGED = new Set(['same', 'unchanged']);
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const json = (v) => (v === undefined ? '(none)' : JSON.stringify(v, null, 2));
// An item may carry an explicit tone (raw mode cannot tell which side an
// "only in" status is on from its label alone); otherwise it is derived.
const tone = ({ status, tone: given }) => given
  ?? (UNCHANGED.has(status) ? 'unchanged'
    : /^only in/.test(status) ? 'neutral'
      : status === 'create' ? 'added'
        : status === 'skip-drift' || status === 'manual' ? 'attention' : 'changed');

const CSS = `
:root {
  --bg: #f7f7f5; --surface: #ffffff; --text: #1d1d1b; --muted: #6b6b66;
  --border: #e2e1dc; --changed: #9a5b00; --changed-bg: #fdf1dc;
  --added: #1f6f43; --added-bg: #e1f3e8; --neutral-bg: #efeeea;
  --attention: #5b3fa0; --attention-bg: #ece6fa;
  --error: #a32020; --error-bg: #fbe4e4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161615; --surface: #1f1f1d; --text: #ecebe6; --muted: #a3a29b;
    --border: #353531; --changed: #f0b45a; --changed-bg: #3a2c14;
    --added: #7ed3a2; --added-bg: #163423; --neutral-bg: #2a2a27;
    --attention: #b9a4f0; --attention-bg: #2a2145;
    --error: #f29a9a; --error-bg: #3d1c1c;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.5rem; margin: 0 0 4px; overflow-wrap: anywhere; }
.sub { color: var(--muted); margin: 0 0 16px; overflow-wrap: anywhere; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; padding: 0; list-style: none; }
.chip { background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 4px 12px; }
.chip b { font-variant-numeric: tabular-nums; }
.toggle { display: inline-flex; gap: 8px; align-items: center; margin: 0 0 16px; cursor: pointer; }
details { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin: 0 0 12px; }
summary { padding: 10px 14px; cursor: pointer; font-weight: 600; }
summary .n { color: var(--muted); font-weight: 400; }
.item { border-top: 1px solid var(--border); padding: 10px 14px; }
.item header { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.key { font-family: ui-monospace, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.status { font-size: 0.8rem; border-radius: 4px; padding: 1px 6px; background: var(--neutral-bg); }
.status.changed { background: var(--changed-bg); color: var(--changed); }
.status.added { background: var(--added-bg); color: var(--added); }
.status.attention { background: var(--attention-bg); color: var(--attention); }
body:not(.show-unchanged) .item.unchanged { display: none; }
.scroll { overflow-x: auto; margin-top: 8px; }
table { border-collapse: collapse; width: 100%; min-width: 480px; font-size: 0.85rem; }
th, td { text-align: left; vertical-align: top; border: 1px solid var(--border); padding: 6px 8px; }
th { background: var(--neutral-bg); }
td pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, Menlo, Consolas, monospace; }
.notes { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; margin: 0 0 12px; }
.notes.errors { background: var(--error-bg); color: var(--error); }
.notes ul { margin: 4px 0 0; padding-left: 20px; overflow-wrap: anywhere; }
`;

const SCRIPT = `
document.getElementById('show-unchanged').addEventListener('change', function (e) {
  document.body.classList.toggle('show-unchanged', e.target.checked);
});
`;

function renderItem(item) {
  const t = tone(item);
  const rows = (item.diff ?? []).map((d) => `<tr><td><pre>${escapeHtml(d.path)}</pre></td>`
    + `<td><pre>${escapeHtml(json(d.from))}</pre></td><td><pre>${escapeHtml(json(d.to))}</pre></td></tr>`).join('\n');
  const table = rows
    ? `<div class="scroll"><table><thead><tr><th>Path</th><th>From</th><th>To</th></tr></thead><tbody>\n${rows}\n</tbody></table></div>`
    : '';
  return `<div class="item ${t}"><header><span class="status ${t}">${escapeHtml(item.status)}</span>`
    + `<span class="key">${escapeHtml(item.key)}</span></header>${table}</div>`;
}

function renderGroup(group) {
  const changed = group.items.filter((i) => !UNCHANGED.has(i.status)).length;
  return `<details${changed ? ' open' : ''}>
<summary>${escapeHtml(group.type)} <span class="n">${changed} changed of ${group.items.length}</span></summary>
${group.items.map(renderItem).join('\n')}
</details>`;
}

function renderNotes(title, list, cls) {
  if (!list?.length) return '';
  return `<section class="notes ${cls}"><strong>${escapeHtml(title)}</strong><ul>${list.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul></section>`;
}

export function renderHtml({ title, subtitle, generatedAt, summary = [], groups = [], warnings = [], errors = [] }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Environment Comparison</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p class="sub">${escapeHtml(subtitle)} · generated ${escapeHtml(generatedAt)}</p>
<ul class="chips">${summary.map((s) => `<li class="chip">${escapeHtml(s.label)} <b>${escapeHtml(s.count)}</b></li>`).join('')}</ul>
<label class="toggle"><input type="checkbox" id="show-unchanged"> Show unchanged</label>
${renderNotes('Errors', errors, 'errors')}
${renderNotes('Warnings', warnings, 'warnings')}
${groups.map(renderGroup).join('\n')}
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
