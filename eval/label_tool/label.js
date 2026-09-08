/**
 * Draw boxes on a screenshot, pick a class, get labels.json.
 *
 * Local and offline: a file input and a download, no server, no upload. A labelling tool
 * that posts a screenshot somewhere is the wrong shape for a corpus whose whole premise
 * is that pages carrying personal data never leave the machine.
 *
 * The frozen vocabulary is duplicated here as a literal rather than imported, because
 * this is a plain HTML page with no build step. `eval/label_tool/check.mjs` compares it
 * against `shared/placeholders.ts` and fails if the two drift.
 */

const CLASSES = [
  'PERSON',
  'ADDRESS',
  'EMAIL',
  'PHONE',
  'DOB',
  'AADHAAR',
  'PAN',
  'GSTIN',
  'IFSC',
  'UPI',
  'ACCOUNT',
  'CARD',
  'PASSPORT',
  'LICENCE',
  'ORG',
  'SECRET',
  // A photograph of a person, found by L3 in pixels. Label it only on pages that
  // actually carry one -- a recall of 1.00 over four faces is a fine number to report,
  // and it is only fine if the four is visible beside it.
  'FACE',
];

/** What an `element` box is for: element recall, so it needs a role, not a PII class. */
const ROLES = ['textbox', 'button', 'link', 'checkbox', 'radio', 'combobox', 'other'];

const COLOUR = { pii: '#0072b2', neg: '#d55e00', el: '#009e73' };

const shot = document.getElementById('shot');
const svg = document.getElementById('boxes');
const list = document.getElementById('list');
const out = document.getElementById('out');
const clsSelect = document.getElementById('cls');
const why = document.getElementById('why');
const pageId = document.getElementById('page-id');

let kind = 'pii';
let boxes = [];
/** Natural pixel size of the screenshot, which is what boxes are recorded in. */
let natural = { w: 0, h: 0 };

function fillClasses() {
  const options = kind === 'el' ? ROLES : CLASSES;
  clsSelect.innerHTML = options.map((c) => `<option>${c}</option>`).join('');
}

for (const button of document.querySelectorAll('.kinds button')) {
  button.addEventListener('click', () => {
    kind = button.dataset.kind;
    for (const other of document.querySelectorAll('.kinds button')) {
      other.setAttribute('aria-pressed', String(other === button));
    }
    fillClasses();
  });
}

document.getElementById('file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  shot.src = URL.createObjectURL(file);
  shot.onload = () => {
    natural = { w: shot.naturalWidth, h: shot.naturalHeight };
    svg.setAttribute('viewBox', `0 0 ${natural.w} ${natural.h}`);
    svg.setAttribute('width', shot.width);
    svg.setAttribute('height', shot.height);
    if (!pageId.value) pageId.value = file.name.replace(/\.[a-z]+$/i, '');
    render();
  };
});

// -- drawing ------------------------------------------------------------------

let start = null;

/** Screen coordinates to the screenshot's own pixels, whatever the browser scaled it to. */
function toImage(event) {
  const rect = shot.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * natural.w,
    y: ((event.clientY - rect.top) / rect.height) * natural.h,
  };
}

svg.addEventListener('pointerdown', (e) => {
  if (!natural.w) return;
  start = toImage(e);
  svg.setPointerCapture(e.pointerId);
});

svg.addEventListener('pointermove', (e) => {
  if (!start) return;
  render(rectBetween(start, toImage(e)));
});

svg.addEventListener('pointerup', (e) => {
  if (!start) return;
  const box = rectBetween(start, toImage(e));
  start = null;
  // A stray click is not a box. Four pixels is below anything anyone means to draw.
  if (box.w < 4 || box.h < 4) return render();

  boxes.push({ kind, cls: clsSelect.value, why: why.value.trim(), box });
  render();
});

function rectBetween(a, b) {
  return {
    x: Math.round(Math.min(a.x, b.x)),
    y: Math.round(Math.min(a.y, b.y)),
    w: Math.round(Math.abs(a.x - b.x)),
    h: Math.round(Math.abs(a.y - b.y)),
  };
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Backspace' && e.target === document.body) {
    boxes.pop();
    render();
  }
});

// -- rendering ----------------------------------------------------------------

function render(pending) {
  const shapes = boxes.map(
    (b) =>
      `<rect x="${b.box.x}" y="${b.box.y}" width="${b.box.w}" height="${b.box.h}"
             fill="none" stroke="${COLOUR[b.kind]}" stroke-width="2" />
       <text x="${b.box.x}" y="${Math.max(11, b.box.y - 3)}" fill="${COLOUR[b.kind]}"
             font-size="11" font-family="ui-monospace, monospace">${b.cls}</text>`,
  );
  if (pending) {
    shapes.push(
      `<rect x="${pending.x}" y="${pending.y}" width="${pending.w}" height="${pending.h}"
             fill="none" stroke="${COLOUR[kind]}" stroke-width="2" stroke-dasharray="4 3" />`,
    );
  }
  svg.innerHTML = shapes.join('');

  list.innerHTML = boxes
    .map(
      (b, i) =>
        `<li><span class="swatch ${b.kind}">${b.cls}</span>
           <button data-i="${i}" title="remove">&times;</button></li>`,
    )
    .join('');
  for (const button of list.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      boxes.splice(Number(button.dataset.i), 1);
      render();
    });
  }

  out.value = JSON.stringify(labels(), null, 1);
}

function labels() {
  return {
    id: pageId.value || 'unnamed',
    labelledBy: 'hand',
    document: { w: natural.w, h: natural.h },
    spans: boxes
      .filter((b) => b.kind === 'pii')
      .map((b) => ({
        cls: b.cls,
        box: b.box,
        boxKind: 'text',
        medium: 'text',
        inViewport: true,
      })),
    negatives: boxes
      .filter((b) => b.kind === 'neg')
      .map((b) => ({ looksLike: b.cls, why: b.why, box: b.box, inViewport: true })),
    elements: boxes
      .filter((b) => b.kind === 'el')
      .map((b) => ({ role: b.cls, name: b.why, box: b.box, inViewport: true })),
  };
}

document.getElementById('save').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(labels(), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${pageId.value || 'labels'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

fillClasses();
render();
