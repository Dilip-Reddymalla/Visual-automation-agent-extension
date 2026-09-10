import { describe, it, expect } from 'vitest';
import { perceive } from './perceive';
import { fixture, page } from './fixture';

/**
 * The Amazon.in search bar, as it is actually shipped.
 *
 * Boxes measured off www.amazon.in in a 807x589 viewport.
 */
const NAV = page(`
  <div id="nav-fill-search" class="nav-fill" data-box="346,0,302,60">
    <div id="nav-search" data-box="346,0,302,60">
      <script>window.navmet.tmp=+new Date();</script>
      <form id="nav-search-bar-form" class="nav-searchbar nav-progressive-attribute" role="search" data-box="349,10,295,40">
        <div class="nav-left" data-box="349,10,52,40">
          <div id="nav-search-dropdown-card" data-box="349,10,52,40">
            <div class="nav-search-scope nav-sprite" data-box="349,10,52,40">
              <select id="searchDropdownBox" class="nav-search-dropdown searchSelect nav-progressive-attribute" data-box="350,10,199,35">
                <option>All Categories</option><option>Alexa Skills</option>
              </select>
              <div class="nav-search-facade" data-box="355,14,45,38">
                <span id="nav-search-label-id" class="nav-search-label" data-box="360,14,19,33">All</span>
              </div>
            </div>
          </div>
        </div>
        <div class="nav-fill" data-box="401,10,198,40">
          <div class="nav-search-field " data-box="401,10,198,40">
            <label for="twotabsearchtextbox" data-box="0,0,0,0">Search Amazon.in</label>
            <input id="twotabsearchtextbox" class="nav-input nav-progressive-attribute" type="text"
                   role="searchbox" placeholder="Search Amazon.in" data-box="401,11,198,38" />
          </div>
        </div>
        <div class="nav-right" data-box="599,10,45,40">
          <div class="nav-search-submit nav-sprite" data-box="599,10,45,40">
            <span id="nav-search-submit-text" data-box="599,10,45,40">
              <input id="nav-search-submit-button" class="nav-input nav-progressive-attribute" type="submit" value="Go" data-box="599,10,45,40" />
            </span>
          </div>
        </div>
      </form>
    </div>
  </div>
`);

describe('the amazon.in search bar', () => {
  function observe() {
    return perceive(fixture(NAV, { viewport: { w: 807, h: 589 } }).env).observed;
  }

  /**
   * The defect this file exists for.
   *
   * Live run, goal "open amazon.in and search for mobiles": the agent reported success
   * having clicked the "Mobiles" link in the nav bar, with the search box still empty.
   * It could not have done anything else -- the element list it was given contained no
   * field of any kind. The `<input>` had collapsed into its wrapper `<div>`, because the
   * wrapper's name resolved through the same label text, and what survived was role
   * `other`, which no `fill` can resolve.
   */
  it('reports the search field as a field', () => {
    const search = observe().find((e) => e.name === 'Search Amazon.in');
    expect(search?.tag).toBe('input');
    expect(search?.role).toBe('searchbox');
    expect(search?.index).toBeDefined();
  });

  it('keeps the submit button and the department dropdown', () => {
    const observed = observe();
    expect(observed.find((e) => e.name === 'Go')?.role).toBe('button');
    expect(observed.find((e) => e.tag === 'select')?.role).toBe('combobox');
  });

  /** One entry for one control: the wrappers must not come back as peers of the input. */
  it('does not report the wrappers as well', () => {
    const named = observe().filter((e) => e.name === 'Search Amazon.in');
    expect(named).toHaveLength(1);
  });

  /**
   * `textContent` walks into `<script>`. Amazon has an inline analytics script inside the
   * nav container, and its source was arriving as an accessible name -- handed to the
   * planner, and read by the detectors as though it were page text.
   */
  it('does not name anything after an inline script', () => {
    for (const element of observe()) {
      expect(element.name).not.toContain('navmet');
      expect(element.name).not.toContain('new Date()');
    }
  });
});
