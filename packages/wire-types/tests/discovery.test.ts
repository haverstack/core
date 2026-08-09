import { describe, it, expect } from 'vitest';
import { WIRE_PROTOCOL_VERSION, parseProtocolVersion, isProtocolCompatible } from '../src/index.js';

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
