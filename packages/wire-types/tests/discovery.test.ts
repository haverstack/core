import { describe, it, expect } from 'vitest';
import {
  WIRE_PROTOCOL_VERSION,
  parseProtocolVersion,
  isProtocolCompatible,
  normalizeCapabilities,
} from '../src/index.js';
import type { DiscoveryCapabilities } from '../src/index.js';
import type { AdapterCapabilities } from '@haverstack/core/adapter';

describe('parseProtocolVersion', () => {
  it('splits a MAJOR.MINOR version', () => {
    expect(parseProtocolVersion('1.0')).toEqual({ major: 1, minor: 0 });
    expect(parseProtocolVersion('12.34')).toEqual({ major: 12, minor: 34 });
  });

  it('returns null for anything that is not MAJOR.MINOR', () => {
    for (const bad of ['1', '1.0.0', 'v1.0', '1.x', '', ' 1.0']) {
      expect(parseProtocolVersion(bad)).toBeNull();
    }
  });
});

describe('isProtocolCompatible', () => {
  it('accepts a matching major', () => {
    expect(isProtocolCompatible('1.0', '1.0')).toBe(true);
  });

  it('accepts either side having the higher minor', () => {
    expect(isProtocolCompatible('1.9', '1.0')).toBe(true);
    expect(isProtocolCompatible('1.0', '1.9')).toBe(true);
  });

  it('rejects a differing major in either direction', () => {
    expect(isProtocolCompatible('2.0', '1.0')).toBe(false);
    expect(isProtocolCompatible('1.0', '2.0')).toBe(false);
  });

  it('rejects an unparseable version rather than guessing', () => {
    expect(isProtocolCompatible('', '1.0')).toBe(false);
    expect(isProtocolCompatible('v1', '1.0')).toBe(false);
  });

  it('compares against this package’s own version by default', () => {
    expect(isProtocolCompatible(WIRE_PROTOCOL_VERSION)).toBe(true);
  });
});

// -------------------------------------------------------
// normalizeCapabilities — one rule for absent, malformed and
// unrecognized alike, so no call site defaults a key of its own.
// -------------------------------------------------------

const NONE: AdapterCapabilities = {
  filter: { content: 'none', contentPresent: false, search: false },
  sort: { fields: [], contentField: false },
  limits: { attachmentBytes: null, contentBytes: null },
};

describe('normalizeCapabilities', () => {
  it('reads what a server declares', () => {
    expect(
      normalizeCapabilities({
        filter: { content: 'path', contentPresent: true, search: true },
        sort: { fields: ['createdAt', 'version'], contentField: true },
        limits: { attachmentBytes: 52428800, contentBytes: 1048576 },
      }),
    ).toEqual({
      filter: { content: 'path', contentPresent: true, search: true },
      sort: { fields: ['createdAt', 'version'], contentField: true },
      limits: { attachmentBytes: 52428800, contentBytes: 1048576 },
    });
  });

  it('reads an absent capabilities object as declaring nothing', () => {
    expect(normalizeCapabilities(undefined)).toEqual(NONE);
    expect(normalizeCapabilities({})).toEqual(NONE);
  });

  it('reads an absent group as declaring nothing, not as inheriting its siblings', () => {
    expect(normalizeCapabilities({ filter: { content: 'path' } })).toEqual({
      ...NONE,
      filter: { content: 'path', contentPresent: false, search: false },
    });
  });

  // A rung this client has never heard of places nowhere on the ladder, so
  // the only reading available is the bottom of it. Refusing a query is
  // recoverable; presenting an unfiltered superset as a filtered result
  // is not.
  it('reads an unrecognized content reach as none', () => {
    for (const reach of ['range', 'PATH', 'true', '']) {
      expect(normalizeCapabilities({ filter: { content: reach } }).filter.content).toBe('none');
    }
  });

  // Only `true` is a declaration; a server sending anything else has not
  // said it honors the key, whatever that value's truthiness.
  it('reads a non-boolean flag as false', () => {
    const capabilities = {
      filter: { contentPresent: 'yes', search: 1 },
      sort: { contentField: {} },
    } as unknown as DiscoveryCapabilities;
    expect(normalizeCapabilities(capabilities)).toEqual(NONE);
  });

  it('drops a sort field outside the native set rather than naming it back', () => {
    expect(
      normalizeCapabilities({ sort: { fields: ['createdAt', 'slug', 'id'] } }).sort.fields,
    ).toEqual(['createdAt']);
  });

  // Null is "this client cannot pre-check", never "unbounded" and never
  // undefined leaking into the numeric comparison Stack.create() makes
  // against it. The server's own ceiling stays authoritative.
  it('reads an absent or unusable limit as null', () => {
    const capabilities = {
      limits: { attachmentBytes: '52428800', contentBytes: Number.NaN },
    } as unknown as DiscoveryCapabilities;
    expect(normalizeCapabilities(capabilities).limits).toEqual({
      attachmentBytes: null,
      contentBytes: null,
    });
    expect(normalizeCapabilities({ limits: { attachmentBytes: 0 } }).limits.attachmentBytes).toBe(
      0,
    );
  });
});
