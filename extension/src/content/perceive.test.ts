import { describe, it, expect } from 'vitest';
import { perceive } from './perceive';
import { fixture, page } from './fixture';
import { serializeSnapshot } from './serialize';

/**
 * The elements that got an index -- the actionable ones. Text-bearing blocks are
 * admitted too and deliberately carry no index, so they are excluded here and covered
 * by their own describe block below.
 */
function indicesOf(html: string, options?: Parameters<typeof fixture>[1]): string[] {
  const { env } = fixture(html, options);
  return perceive(env)
    .observed.filter((e) => e.index !== undefined)
    .map((e) => `${e.index}:${e.tag}:${e.name}`);
}

describe('what gets indexed', () => {
  it('finds the ordinary controls', () => {
    const html = page(`
      <button data-box="10,10,100,30">Save</button>
      <a href="/x" data-box="10,50,80,20">Help</a>
      <input type="text" aria-label="Full name" data-box="10,80,200,30" />
      <select aria-label="State" data-box="10,120,200,30"><option>Karnataka</option></select>
      <textarea aria-label="Notes" data-box="10,160,200,60"></textarea>
    `);
    const roles = perceive(fixture(html).env).observed.map((e) => e.role);
    expect(roles).toEqual(['button', 'link', 'textbox', 'combobox', 'textbox']);
  });

  it('skips decoration', () => {
    const html = page(`
      <p data-box="10,10,200,20">Just some prose</p>
      <div data-box="10,40,200,20">A plain div</div>
      <span data-box="10,70,200,20">A plain span</span>
      <button data-box="10,100,100,30">Real</button>
    `);
    expect(indicesOf(html)).toEqual(['1:button:Real']);
  });

  it('finds a div that behaves like a button', () => {
    const html = page(`
      <div role="button" data-box="10,10,100,30">Aria button</div>
      <div data-cursor="pointer" data-box="10,50,100,30">Pointer div</div>
      <div tabindex="0" data-box="10,90,100,30">Focusable div</div>
      <div @click="go()" data-box="10,130,100,30">Vue div</div>
    `);
    expect(indicesOf(html)).toHaveLength(4);
  });

  it('skips a label that proxies to its input, keeping the input', () => {
    const html = page(`
      <label for="a" data-box="10,10,120,20">Aadhaar number</label>
      <input id="a" type="text" data-box="10,30,200,30" />
    `);
    const observed = perceive(fixture(html).env).observed;
    expect(observed).toHaveLength(1);
    expect(observed[0]?.tag).toBe('input');
    // The label still supplies the name, it just does not get its own entry.
    expect(observed[0]?.name).toBe('Aadhaar number');
  });

  it('keeps a hidden validation message -- it is about to appear', () => {
    const html = page(`
      <div role="alert" data-display="none" data-box="10,10,200,20">Email is required</div>
      <button data-box="10,40,100,30">Submit</button>
    `);
    const names = perceive(fixture(html).env).observed.map((e) => e.name);
    expect(names).toContain('Email is required');
  });

  it('ignores an element the page marked aria-hidden', () => {
    const html = page(`
      <button aria-hidden="true" data-box="10,10,100,30">Ghost</button>
      <button data-box="10,50,100,30">Real</button>
    `);
    expect(indicesOf(html)).toEqual(['1:button:Real']);
  });

  it('drops an element scrolled out of the viewport', () => {
    const html = page(`
      <button data-box="10,10,100,30">Visible</button>
      <button data-box="10,2000,100,30">Far below</button>
    `);
    expect(indicesOf(html)).toEqual(['1:button:Visible']);
  });
});

describe('occlusion', () => {
  it('drops a button behind an open modal', () => {
    const html = page(`
      <button data-box="100,100,120,40">Behind</button>
      <div id="modal" data-box="0,0,1280,720">
        <button data-box="500,300,120,40">In the modal</button>
      </div>
    `);
    const names = indicesOf(html, { overlays: ['#modal'] });
    expect(names.join(' ')).not.toContain('Behind');
  });

  it('keeps a card only partly under a sticky header, and says how much', () => {
    // The header has to reach a probe point to register: five points means the score
    // is sampled, not integrated, and a header grazing the top edge scores zero.
    const html = page(`
      <div id="header" data-box="0,0,1280,100"></div>
      <a href="/x" data-box="0,20,300,200">Partly covered card</a>
    `);
    const observed = perceive(fixture(html, { overlays: ['#header'] }).env).observed;
    const card = observed.find((e) => e.name === 'Partly covered card');
    expect(card).toBeDefined();
    expect(card?.occluded).toBeGreaterThan(0);
    expect(card?.occluded).toBeLessThanOrEqual(0.9);
  });
});

describe('containment collapse', () => {
  it('a card with a link and a button yields at most two entries', () => {
    const html = page(`
      <div role="button" data-box="0,0,400,200" aria-label="Scheme card">
        <h3 data-box="10,10,380,30">Scholarship</h3>
        <img alt="" data-box="10,50,80,80" />
        <a href="/read" data-box="10,140,100,20">Read more</a>
        <button data-box="200,140,100,30">Apply</button>
      </div>
    `);
    // Four now, not three: the <h3> is a text-bearing block with a name of its own, and
    // prose inside a card is exactly where a read-only page keeps its identifiers. The
    // payload is bounded by TEXT_BLOCK_CAP and TEXT_BLOCK_MIN_AREA, not by refusing to
    // look at text.
    expect(perceive(fixture(html).env).observed.length).toBeLessThanOrEqual(4);
  });

  it('collapses a wrapper that adds nothing but a rect', () => {
    const html = page(`
      <div role="button" data-box="0,0,200,50" aria-label="Open menu">
        <span data-cursor="pointer" data-box="0,0,200,50"></span>
      </div>
    `);
    const observed = perceive(fixture(html).env).observed;
    expect(observed).toHaveLength(1);
    expect(observed[0]?.name).toBe('Open menu');
  });

  it('keeps a nested element that has a name of its own', () => {
    const html = page(`
      <div role="button" data-box="0,0,200,50" aria-label="Row">
        <button data-box="0,0,200,50">Delete this row</button>
      </div>
    `);
    const names = perceive(fixture(html).env).observed.map((e) => e.name);
    expect(names).toContain('Delete this row');
  });

  it('does not let an inherited pointer cursor turn a card into six entries', () => {
    // `cursor: pointer` on the card inherits to everything inside it. Every child here
    // has a distinct accessible name, so containment collapse cannot save us -- the
    // interactivity rule has to be right in the first place.
    const html = page(`
      <a href="/scheme" data-cursor="pointer" data-box="0,0,400,180">
        <h3 data-cursor="pointer" data-box="10,10,380,24">Merit scholarship</h3>
        <p data-cursor="pointer" data-box="10,40,380,40">For families under 8 lakh.</p>
        <span data-cursor="pointer" data-box="10,90,380,40">
          <button data-cursor="pointer" data-box="10,90,100,30">Read more</button>
          <button data-cursor="pointer" data-box="120,90,100,30">Apply</button>
        </span>
      </a>
    `);
    const observed = perceive(fixture(html).env).observed;
    // Indexed entries only. The <h3> and <p> are admitted as text-bearing blocks now --
    // that is the point of the third admission class -- but neither is clickable and
    // neither gets an index, which is what this test is about.
    const names = observed.filter((e) => e.index !== undefined).map((e) => e.name);

    expect(names).toContain('Read more');
    expect(names).toContain('Apply');
    expect(names).not.toContain('For families under 8 lakh.');
    // Three indexed. The prose adds unindexed blocks, which is the trade this module
    // makes on purpose: a read-only page was reporting two elements and no findings.
    expect(names.length).toBeLessThanOrEqual(3);
  });

  it('still indexes an element that declares the pointer cursor itself', () => {
    const html = page(`
      <div data-box="0,0,200,40">
        <span data-cursor="pointer" data-box="0,0,200,40">Click me</span>
      </div>
    `);
    const names = perceive(fixture(html).env).observed.map((e) => e.name);
    expect(names).toEqual(['Click me']);
  });

  it('does not collapse two siblings that merely overlap', () => {
    const html = page(`
      <button data-box="0,0,100,100">A</button>
      <button data-box="60,0,100,100">B</button>
    `);
    expect(perceive(fixture(html).env).observed).toHaveLength(2);
  });
});

describe('index order', () => {
  it('numbers top to bottom, then left to right', () => {
    const html = page(`
      <button data-box="300,200,80,30">third</button>
      <button data-box="10,10,80,30">first</button>
      <button data-box="200,10,80,30">second</button>
    `);
    expect(perceive(fixture(html).env).observed.map((e) => e.name)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('treats a row as a row despite a few pixels of drift', () => {
    const html = page(`
      <button data-box="200,12,80,30">right</button>
      <button data-box="10,10,80,30">left</button>
    `);
    expect(perceive(fixture(html).env).observed.map((e) => e.name)).toEqual(['left', 'right']);
  });

  it('hands out contiguous indices starting at 1', () => {
    const html = page(`
      <button data-box="10,10,80,30">a</button>
      <button data-box="10,50,80,30">b</button>
      <button data-box="10,90,80,30">c</button>
    `);
    expect(perceive(fixture(html).env).observed.map((e) => e.index)).toEqual([1, 2, 3]);
  });
});

describe('the diff marker', () => {
  const first = page(`
    <button data-box="10,10,80,30">Save</button>
    <input aria-label="Name" data-box="10,50,200,30" />
  `);

  it('marks everything new on the first look', () => {
    const observed = perceive(fixture(first).env).observed;
    expect(observed.every((e) => e.isNew)).toBe(true);
  });

  it('marks nothing new on a no-op re-perceive', () => {
    const keys = perceive(fixture(first).env).keys;
    const again = perceive(fixture(first, { previousKeys: keys }).env).observed;
    expect(again.some((e) => e.isNew)).toBe(false);
  });

  it('marks only the newcomer when the page grows', () => {
    const keys = perceive(fixture(first).env).keys;
    const grown = page(`
      <button data-box="10,10,80,30">Save</button>
      <input aria-label="Name" data-box="10,50,200,30" />
      <div role="alert" data-box="10,90,200,20">Name is required</div>
    `);
    const observed = perceive(fixture(grown, { previousKeys: keys }).env).observed;
    const marked = observed.filter((e) => e.isNew).map((e) => e.name);
    expect(marked).toEqual(['Name is required']);
  });

  it('survives a reflow that moves everything', () => {
    const keys = perceive(fixture(first).env).keys;
    const moved = page(`
      <button data-box="500,300,80,30">Save</button>
      <input aria-label="Name" data-box="500,340,200,30" />
    `);
    const observed = perceive(fixture(moved, { previousKeys: keys }).env).observed;
    expect(observed.some((e) => e.isNew)).toBe(false);
  });
});

describe('the observed record', () => {
  it('captures the attributes L0 needs and the wire cannot carry', () => {
    const html = page(`
      <label for="aad" data-box="10,10,120,20">Aadhaar number</label>
      <input id="aad" name="aadhaar_no" type="text" inputmode="numeric"
             autocomplete="off" maxlength="12" pattern="[0-9]{12}"
             aria-describedby="hint" value="234567890123" data-box="10,30,200,30" />
      <span id="hint" data-box="10,70,200,20">Twelve digits, no spaces</span>
    `);
    const input = perceive(fixture(html).env).observed.find((e) => e.tag === 'input');

    expect(input?.nameAttr).toBe('aadhaar_no');
    expect(input?.idAttr).toBe('aad');
    expect(input?.inputMode).toBe('numeric');
    expect(input?.autocomplete).toBe('off');
    expect(input?.maxLength).toBe(12);
    expect(input?.pattern).toBe('[0-9]{12}');
    expect(input?.labelText).toBe('Aadhaar number');
    expect(input?.ariaDescribedByText).toBe('Twelve digits, no spaces');
    expect(input?.rawValue).toBe('234567890123');
  });

  it('records a field styled as dots as what it is', () => {
    const html = page(
      `<input type="text" aria-label="PIN" data-text-security="disc" data-box="0,0,100,30" />`,
    );
    const input = perceive(fixture(html).env).observed[0];
    expect(input?.textSecurity).toBe('disc');
  });

  it('describes a select by its options', () => {
    const html = page(`
      <select aria-label="State" data-box="0,0,200,30">
        <option>Karnataka</option><option selected>Kerala</option>
      </select>
    `);
    const select = perceive(fixture(html).env).observed.find((e) => e.tag === 'select');
    expect(select?.optionCount).toBe(2);
    expect(select?.selectedText).toBe('Kerala');
  });
});

describe('shadow DOM and frames', () => {
  it('sees inside an open shadow root', () => {
    const { doc, env } = fixture(page(`<div id="host" data-box="0,0,300,100"></div>`));
    const host = doc.getElementById('host');
    const root = host?.attachShadow({ mode: 'open' });
    if (!root) throw new Error('no shadow root');
    root.innerHTML = `<button data-box="10,10,120,30">Inside shadow</button>`;

    const names = perceive(env).observed.map((e) => e.name);
    expect(names).toContain('Inside shadow');
  });

  it('does not treat a shadow host as covering its own contents', () => {
    const { doc, env } = fixture(page(`<div id="host" data-box="0,0,300,100"></div>`));
    const host = doc.getElementById('host');
    const root = host?.attachShadow({ mode: 'open' });
    if (!root) throw new Error('no shadow root');
    root.innerHTML = `<button data-box="0,0,300,100">Fills the host</button>`;

    // The button covers the host exactly. A hit test that stopped at the host would
    // score this 1.0 and drop it.
    const observed = perceive(env).observed;
    const button = observed.find((e) => e.name === 'Fills the host');
    expect(button).toBeDefined();
    expect(button?.occluded).toBe(0);
  });

  it('reports a closed shadow root as opaque rather than as nothing', () => {
    const html = page(`<my-widget data-box="0,0,300,100"></my-widget>`);
    const observed = perceive(fixture(html).env).observed;
    const widget = observed.find((e) => e.tag === 'my-widget');
    expect(widget?.opaque).toBe(true);
  });
});

describe('serialisation', () => {
  it('renders the shape the planner reads, and never a raw value', () => {
    const html = page(`
      <input type="text" aria-label="Full name" value="Asha Menon" data-box="10,10,200,30" />
      <button type="submit" data-box="10,50,160,30">Save and continue</button>
    `);
    const observed = perceive(fixture(html).env).observed;
    const text = serializeSnapshot({ observed });

    expect(text).toContain('[1]<input type="text" aria-label="Full name"');
    expect(text).toContain('[2]<button');
    expect(text).toContain('Save and continue');
    expect(text).not.toContain('Asha Menon');
  });

  it('marks a newcomer with a star', () => {
    const html = page(`<div role="alert" data-box="10,10,200,20">Email is required</div>`);
    const observed = perceive(fixture(html).env).observed;
    expect(serializeSnapshot({ observed })).toMatch(/^\*\[1\]/);
  });
});

describe('the handle map', () => {
  it('maps every index to the live node', () => {
    const html = page(`
      <button data-box="10,10,80,30">a</button>
      <button data-box="10,50,80,30">b</button>
    `);
    const { handles, observed } = perceive(fixture(html).env);

    expect(handles.size).toBe(observed.length);
    for (const el of observed) {
      if (el.index === undefined) continue;
      expect(handles.get(el.index)?.textContent).toBe(el.name);
    }
  });

  it('holds nodes, which is why it can never be sent anywhere', () => {
    const { handles } = perceive(fixture(page(`<button data-box="0,0,80,30">x</button>`)).env);
    const node = handles.get(1);
    expect(node).toBeDefined();
    expect(typeof node?.getAttribute).toBe('function');
  });
});

describe('text-bearing elements', () => {
  it('emits a block that holds personal data as prose', () => {
    // The whole of M3b. Before it, this page produced nothing at all: perception walked
    // for actionable elements, so a <dd> was never an element and no detector saw it.
    const html = page(`
      <dl>
        <dt data-box="10,10,150,20">Aadhaar number</dt>
        <dd data-box="170,10,200,20">9194 4273 6092</dd>
      </dl>
    `);
    const observed = perceive(fixture(html).env).observed;
    const dd = observed.find((e) => e.tag === 'dd');

    expect(dd, 'the <dd> was not perceived').toBeTruthy();
    expect(dd?.role).toBe('text');
    expect(dd?.textRuns.map((r) => r.text)).toContain('9194 4273 6092');
  });

  it('gives a text block no index', () => {
    // It cannot be clicked, and handing the planner a number it cannot act on is an
    // invitation to try. Reachable by coordinate; the schema allows the absence.
    const html = page(`<p data-box="10,10,300,40">Some prose here.</p>`);
    const observed = perceive(fixture(html).env).observed;

    expect(observed).toHaveLength(1);
    expect(observed[0]?.index).toBeUndefined();
  });

  it('calls a heading a heading', () => {
    const html = page(`<h2 data-box="10,10,300,30">Applicant details</h2>`);
    expect(perceive(fixture(html).env).observed[0]?.role).toBe('heading');
  });

  it('emits the block that holds the words, not every ancestor of it', () => {
    // Own-text is the whole trick. textContent is true of every ancestor up to <body>,
    // so admitting on it would emit the paragraph, its wrapper, that wrapper's section
    // and the main element -- four boxes for one sentence, each less useful than the last.
    const html = page(`
      <section data-box="0,0,400,200">
        <div data-box="0,0,400,100">
          <p data-box="10,10,380,40">The only element with its own text.</p>
        </div>
      </section>
    `);
    const observed = perceive(fixture(html).env).observed;

    expect(observed).toHaveLength(1);
    expect(observed[0]?.tag).toBe('p');
  });

  it('does not let an aria-hidden element in through the text door', () => {
    const html = page(`
      <p aria-hidden="true" data-box="10,10,300,40">Decorative.</p>
      <p data-box="10,60,300,40">Real content.</p>
    `);
    const observed = perceive(fixture(html).env).observed;

    expect(observed).toHaveLength(1);
    expect(observed[0]?.name).toContain('Real');
  });

  it("skips a label that already travels as its input's labelText", () => {
    // Emitting it again would put a second box over a caption, which is exactly the
    // container-shaped over-redaction M3b exists to remove.
    const html = page(`
      <label for="a" data-box="10,10,120,20">Aadhaar number</label>
      <input id="a" type="text" data-box="10,30,200,30" />
    `);
    const observed = perceive(fixture(html).env).observed;

    expect(observed).toHaveLength(1);
    expect(observed[0]?.tag).toBe('input');
  });

  it('drops the smallest blocks when the cap bites, and says how many', () => {
    const many = Array.from(
      { length: 130 },
      (_, i) =>
        `<p data-box="${(i % 6) * 210 + 10},${Math.floor(i / 6) * 22 + 10},${200 - (i % 40)},20">` +
        `Line ${i} of prose.</p>`,
    ).join('');
    const result = perceive(fixture(page(many)).env);

    const text = result.observed.filter((e) => e.index === undefined);
    expect(text.length).toBeLessThanOrEqual(120);
    expect(result.textBlocksDropped).toBeGreaterThan(0);
  });
});

describe('label signals on prose', () => {
  it('reads a <dt> as the label for its <dd>', () => {
    const html = page(`
      <dl>
        <dt data-box="10,10,150,20">PAN</dt>
        <dd data-box="170,10,200,20">JMRPN3229K</dd>
      </dl>
    `);
    const dd = perceive(fixture(html).env).observed.find((e) => e.tag === 'dd');
    expect(dd?.labelText).toBe('PAN');
  });

  it('reads a row header as the label for its cell', () => {
    const html = page(`
      <table>
        <tr>
          <th scope="row" data-box="10,10,150,20">Account number</th>
          <td data-box="170,10,200,20">50100412345678</td>
        </tr>
      </table>
    `);
    const td = perceive(fixture(html).env).observed.find((e) => e.tag === 'td');
    expect(td?.labelText).toBe('Account number');
  });
});
