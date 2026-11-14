import { describe, expect, it } from 'vitest';
import { CID } from 'multiformats/cid';
import {
  evaluatePolicy,
  globMatch,
  ipldEquals,
  parsePolicy,
  parseSelector,
  resolveSelector,
  UcanError,
  type IpldValue,
} from '../src/index.js';

const holds = (pol: unknown, args: IpldValue) => evaluatePolicy(parsePolicy(pol), args);
const select = (selector: string, value: IpldValue) =>
  resolveSelector(parseSelector(selector), value);

// The selector table and its worked example from the UCAN Delegation spec.
const to = ['bob@example.com', 'carol@not.example.com', 'dan@example.com'];
const args: IpldValue = {
  from: 'alice@example.com',
  to,
  cc: ['fraud@example.com'],
  title: 'Meeting Confirmation',
  body: "I'll see you on Tuesday",
};

describe('selectors', () => {
  it('resolve as the spec table gives them', () => {
    expect(select('.', args)).toEqual({ ok: true, value: args });
    expect(select('.title', args)).toEqual({ ok: true, value: 'Meeting Confirmation' });
    expect(select('.cc', args)).toEqual({ ok: true, value: ['fraud@example.com'] });
    expect(select('.to[1]', args)).toEqual({ ok: true, value: 'carol@not.example.com' });
    expect(select('.to[-1]', args)).toEqual({ ok: true, value: 'dan@example.com' });
    expect(select('.to[99]?', args)).toEqual({ ok: true, value: null });
    expect(select('.to[99]', args)).toEqual({ ok: false });
  });

  it('select a missing map key as null, and fail a non-optional segment past it', () => {
    expect(select('.missing', args)).toEqual({ ok: true, value: null });
    expect(select('.missing.deeper', args)).toEqual({ ok: false });
    expect(select('.missing.deeper?', args)).toEqual({ ok: true, value: null });
  });

  it('return early on an unresolvable segment even if a later one is optional', () => {
    expect(select('.title[0].x?', args)).toEqual({ ok: false });
  });

  it('read quoted keys, slices and collection values', () => {
    expect(select('.["title"]', args)).toEqual({ ok: true, value: 'Meeting Confirmation' });
    expect(select('.to[0:2]', args)).toEqual({ ok: true, value: to.slice(0, 2) });
    expect(select('.to[1:]', args)).toEqual({ ok: true, value: to.slice(1) });
    expect(select('.[]', { a: 1, b: 2 })).toEqual({ ok: true, value: [1, 2] });
    expect(select('.items[].n', { items: [{ n: 1 }, { n: 2 }] })).toEqual({
      ok: true,
      value: [1, 2],
    });
  });

  it('fail [] when any element fails the rest of the path', () => {
    expect(select('.items[].n.x', { items: [{ n: { x: 1 } }, { n: 2 }] })).toEqual({ ok: false });
  });

  it('index into bytes as an array of u8', () => {
    expect(select('.[3]', Uint8Array.from([0xd6, 0xa9, 0xc1, 0x8c, 0xf8, 0xc4]))).toEqual({
      ok: true,
      value: 140,
    });
  });

  it('collapse repeated optionals', () => {
    expect(select('.to[99]???', args)).toEqual({ ok: true, value: null });
  });

  it.each(['', 'title', '..', '.a..b', '...', '.a.', '.[x]', '.[', '.a b'])('refuse %j', (s) => {
    expect(() => parseSelector(s)).toThrow(UcanError);
  });
});

describe('statements', () => {
  const katie: IpldValue = { name: 'Katie', age: 35, nationalities: ['Canadian', 'South African'] };

  it('evaluate the and / or / not examples from the spec', () => {
    expect(holds([['and', []]], katie)).toBe(true);
    expect(
      holds(
        [
          [
            'and',
            [
              ['==', '.name', 'Katie'],
              ['>=', '.age', 21],
            ],
          ],
        ],
        katie,
      ),
    ).toBe(true);
    expect(
      holds(
        [
          [
            'and',
            [
              ['==', '.name', 'Katie'],
              ['>=', '.age', 21],
              ['==', '.nationalities', ['American']],
            ],
          ],
        ],
        katie,
      ),
    ).toBe(false);
    expect(holds([['or', []]], katie)).toBe(true);
    expect(
      holds(
        [
          [
            'or',
            [
              ['==', '.name', 'Katie'],
              ['>', '.age', 45],
            ],
          ],
        ],
        katie,
      ),
    ).toBe(true);
    expect(
      holds(
        [
          [
            'not',
            [
              'and',
              [
                ['==', '.name', 'Katie'],
                ['==', '.nationalities', ['American']],
              ],
            ],
          ],
        ],
        katie,
      ),
    ).toBe(true);
  });

  it('evaluate the quantifier examples from the spec', () => {
    const value: IpldValue = { a: [{ b: 1 }, { b: 2 }, { z: [7, 8, 9] }] };
    expect(holds([['all', '.a', ['>', '.b', 0]]], value)).toBe(false);
    expect(holds([['any', '.a', ['==', '.b', 2]]], value)).toBe(true);
  });

  it('treat any over an empty collection as an empty or', () => {
    expect(holds([['any', '.tags', ['==', '.', 'news']]], { tags: [] })).toBe(true);
    expect(holds([['all', '.tags', ['==', '.', 'news']]], { tags: [] })).toBe(true);
  });

  it('evaluate the validation example from the spec', () => {
    const pol = [
      ['==', '.from', 'alice@example.com'],
      ['any', '.to', ['like', '.', '*@example.com']],
    ];
    expect(
      holds(pol, {
        from: 'alice@example.com',
        to: ['bob@example.com', 'carol@elsewhere.example.com'],
      }),
    ).toBe(true);
    expect(holds(pol, { from: 'alice@example.com', to: ['carol@elsewhere.example.com'] })).toBe(
      false,
    );
  });

  it('read != as not ==, so an unresolvable selector satisfies it', () => {
    expect(holds([['!=', '.x[0]', 1]], { x: [] })).toBe(true);
  });

  it('compare numbers regardless of int or float, and refuse non-numbers', () => {
    expect(holds([['<=', '.a', 1.0]], { a: 1 })).toBe(true);
    expect(holds([['>', '.a', 0]], { a: '5' })).toBe(false);
  });

  it('compare deeply, including bytes and CIDs', () => {
    const cid = CID.parse('bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku');
    expect(
      ipldEquals({ a: [1, { b: Uint8Array.of(1) }] }, { a: [1, { b: Uint8Array.of(1) }] }),
    ).toBe(true);
    expect(ipldEquals({ a: Uint8Array.of(1) }, { a: Uint8Array.of(2) })).toBe(false);
    expect(ipldEquals(cid, CID.parse(cid.toString()))).toBe(true);
    expect(ipldEquals({ a: 1 }, { a: 1, b: null })).toBe(false);
  });

  it.each([
    'not an array',
    [['nope', '.a', 1]],
    [['==', 'a', 1]],
    [['==', '.a']],
    [['<', '.a', '1']],
    [['like', '.a', 1]],
    [['and', ['==', '.a', 1]]],
    [['all', '.a', 'x']],
  ])('refuse the malformed policy %j', (pol) => {
    expect(() => parsePolicy(pol)).toThrow(UcanError);
  });
});

describe('globMatch', () => {
  const pattern = 'Alice\\*, Bob*, Carol.';

  it.each([
    'Alice*, Bob, Carol.',
    'Alice*, Bob, Dan, Erin, Carol.',
    'Alice*, Bob  , Carol.',
    'Alice*, Bob*, Carol.',
  ])('match %j as the spec requires', (s) => {
    expect(globMatch(pattern, s)).toBe(true);
  });

  it.each([
    'Alice*, Bob, Carol',
    'Alice*, Bob*, Carol!',
    'Alice, Bob, Carol.',
    'Alice Cooper, Bob, Carol.',
    ' Alice*, Bob, Carol. ',
  ])('refuse %j as the spec requires', (s) => {
    expect(globMatch(pattern, s)).toBe(false);
  });

  it('handle leading, trailing and adjacent wildcards', () => {
    expect(globMatch('*@example.com', 'bob@example.com')).toBe(true);
    expect(globMatch('*@example.com', 'carol@elsewhere.example.com')).toBe(false);
    expect(globMatch('*.example.com', 'carol@elsewhere.example.com')).toBe(true);
    expect(globMatch('commons/*', 'commons/note')).toBe(true);
    expect(globMatch('a**b', 'ab')).toBe(true);
    expect(globMatch('ab*ab', 'ab')).toBe(false);
    expect(globMatch('*', '')).toBe(true);
  });
});
