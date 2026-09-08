/**
 * Reshaping a value to what the field says it takes.
 *
 * The case behind every test here: "DOB is 24th jan 2000" reached the right box on the real
 * parivahan form and left it empty. The field is `maxlength="10"`, its placeholder is
 * `DD-MM-YYYY`, its title says the same, and it validates on change. Nothing was wrong with
 * the perception, the resolution or the plan -- the agent handed the page a shape the page
 * does not take.
 */

import { describe, it, expect } from 'vitest';
import { dateFormatOf, formatValue, parseDate } from './format';

/** The real field, as the page describes it. */
const DOB = {
  inputType: 'text',
  placeholder: 'DD-MM-YYYY',
  title: 'Enter Date of Birth in DD-MM-YYYY Format',
  maxLength: 10,
};

/** Fixed, so a two-digit year has a stable answer to be right or wrong about. */
const NOW = 2026;

describe('reading the format off the field', () => {
  it('takes it from the placeholder', () => {
    expect(dateFormatOf(DOB)).toEqual({
      order: ['D', 'M', 'Y'],
      separator: '-',
      longYear: true,
    });
  });

  it('takes it from the title when the placeholder is silent', () => {
    expect(dateFormatOf({ title: 'Date (MM/DD/YYYY)' })).toEqual({
      order: ['M', 'D', 'Y'],
      separator: '/',
      longYear: true,
    });
  });

  it('knows a date input takes ISO whatever it shows', () => {
    expect(dateFormatOf({ inputType: 'date' })).toEqual({
      order: ['Y', 'M', 'D'],
      separator: '-',
      longYear: true,
    });
  });

  it('reads a two-digit year as one', () => {
    expect(dateFormatOf({ placeholder: 'DD/MM/YY' })?.longYear).toBe(false);
  });

  it('says nothing about a field that says nothing', () => {
    expect(dateFormatOf({ placeholder: 'Your name..' })).toBeUndefined();
    expect(dateFormatOf({})).toBeUndefined();
    // Three parts, but not three different ones.
    expect(dateFormatOf({ placeholder: 'MM-MM-YY' })).toBeUndefined();
  });
});

describe('reading a date a person wrote', () => {
  const DMY: ['D', 'M', 'Y'] = ['D', 'M', 'Y'];

  it('reads the ways people write the same day', () => {
    for (const written of [
      '24th jan 2000',
      '24 jan 2000',
      '24 January 2000',
      'the 24th of Jan, 2000',
      '24/01/2000',
      '24-1-2000',
      '24.01.2000',
      '2000-01-24',
      'jan 24 2000',
    ]) {
      expect(parseDate(written, DMY, NOW), written).toEqual({ y: 2000, m: 1, d: 24 });
    }
  });

  /**
   * The one genuine ambiguity, and the field is the only thing on the page that settles it.
   * 06/07/2000 is the sixth of July or the seventh of June depending on who wrote it.
   */
  it('lets the field decide an all-numeric date', () => {
    expect(parseDate('06/07/2000', ['D', 'M', 'Y'], NOW)).toEqual({ y: 2000, m: 7, d: 6 });
    expect(parseDate('06/07/2000', ['M', 'D', 'Y'], NOW)).toEqual({ y: 2000, m: 6, d: 7 });
  });

  it('lets the string overrule the field when it can', () => {
    // 24 cannot be a month, whatever the field's order says.
    expect(parseDate('24/06/2000', ['M', 'D', 'Y'], NOW)).toEqual({ y: 2000, m: 6, d: 24 });
  });

  /**
   * A date of birth is in the past, so a year that would land in the future is the previous
   * century. Stated rather than assumed: both readings of "20" are defensible, and the
   * completion check re-reads the box so the operator sees what landed.
   */
  it('expands a two-digit year backwards from today', () => {
    expect(parseDate('24-6-20', DMY, NOW)).toEqual({ y: 2020, m: 6, d: 24 });
    expect(parseDate('24-6-99', DMY, NOW)).toEqual({ y: 1999, m: 6, d: 24 });
    expect(parseDate('24-6-30', DMY, NOW)).toEqual({ y: 1930, m: 6, d: 24 });
  });

  it('refuses what is not a date', () => {
    for (const written of [
      'hello there',
      '24',
      '24/06',
      'the 32nd of Jan 2000',
      '24/13/2000',
    ]) {
      expect(parseDate(written, DMY, NOW), written).toBeUndefined();
    }
  });

  /** With no declared order, an all-short date has nothing to settle it. */
  it('does not guess when nothing can settle it', () => {
    expect(parseDate('06/07/08', undefined, NOW)).toBeUndefined();
    // But a part above 12 still settles itself.
    expect(parseDate('24/06/08', undefined, NOW)).toEqual({ y: 2008, m: 6, d: 24 });
  });
});

describe('formatValue', () => {
  it('turns every way of saying it into the one the field takes', () => {
    for (const written of ['24th jan 2000', '24 January 2000', '24/01/2000', '2000-01-24']) {
      expect(formatValue(written, DOB, NOW).text, written).toBe('24-01-2000');
    }
  });

  it('says what it did, without saying what the value was', () => {
    const out = formatValue('24th jan 2000', DOB, NOW);
    expect(out.note).toBe('reformatted to D-M-Y');
    expect(out.note).not.toContain('2000');
  });

  it('stays quiet when nothing needed doing', () => {
    expect(formatValue('24-01-2000', DOB, NOW)).toEqual({ text: '24-01-2000' });
  });

  it('fits the value into the shape the field asked for, short year included', () => {
    expect(formatValue('24th jan 2000', { placeholder: 'DD/MM/YY' }, NOW).text).toBe(
      '24/01/00',
    );
    expect(formatValue('24th jan 2000', { inputType: 'date' }, NOW).text).toBe('2000-01-24');
  });

  /**
   * The rule that keeps this from becoming a source of new bugs. Inventing a shape for a
   * field that never asked for one turns a value the user typed into one they did not.
   */
  it('leaves a field that declares no format completely alone', () => {
    expect(formatValue('24th jan 2000', { placeholder: 'Your name..' }, NOW).text).toBe(
      '24th jan 2000',
    );
    expect(formatValue('leo', {}, NOW).text).toBe('leo');
  });

  it('leaves a value the date field cannot read alone, for the page to judge', () => {
    expect(formatValue('sometime last june', DOB, NOW).text).toBe('sometime last june');
  });

  it('trims, always', () => {
    expect(formatValue('  leo  ', {}, NOW).text).toBe('leo');
    expect(formatValue('   ', {}, NOW).text).toBe('');
  });
});
