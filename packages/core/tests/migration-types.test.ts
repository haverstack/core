import { beforeAll, describe, expect, test } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// What the compiler says about a migration is part of its contract: a
// mistake in a step is one error, on one line, naming the field or type at
// fault. Each case is compiled against core's source under the package's
// own compiler options, never run.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const prelude = `
import { migration, typeHandle } from './src/type-handle.js';
import type { StoredContentOf } from './src/type-handle.js';

const V1 = typeHandle({
  id: 'com.example.reading/book@1',
  name: 'Book',
  schema: {
    title: { kind: 'string', required: true },
    status: { kind: 'string', required: true },
    pages: { kind: 'number' },
  },
});
const V2 = typeHandle({
  id: 'com.example.reading/book@2',
  name: 'Book',
  migratesFrom: V1,
  schema: {
    title: { kind: 'string', required: true },
    status: { kind: 'enum', values: ['want', 'reading', 'finished'], required: true },
    pinned: { kind: 'boolean', required: true },
    rating: { kind: 'number' },
  },
});
type V1C = StoredContentOf<typeof V1.schema>;
`;

const compiles: Record<string, string> = {
  'derive() with a total conditional': `
migration(V1, V2, ({ add, derive }) => [
  derive('status', (c) => (c.status === 'done' ? 'finished' : 'want')),
  add('pinned', false),
]);`,
  'derive() returning a constant': `
migration(V1, V2, ({ add, derive }) => [derive('status', () => 'want'), add('pinned', false)]);
migration(V1, V2, ({ add, derive }) => [derive('status', (_c) => 'want'), add('pinned', false)]);`,
  'derive() with a switch body, a named function or an annotated parameter': `
migration(V1, V2, ({ add, derive }) => [
  derive('status', (c) => {
    switch (c.status) {
      case 'done':
        return 'finished';
      case 'reading':
        return 'reading';
      default:
        return 'want';
    }
  }),
  add('pinned', false),
]);
function statusOf(c: V1C) {
  return c.status === 'done' ? ('finished' as const) : ('want' as const);
}
migration(V1, V2, ({ add, derive }) => [derive('status', statusOf), add('pinned', false)]);
migration(V1, V2, ({ add, derive }) => [
  derive('status', (c: V1C) => (c.status === 'done' ? 'finished' : 'want')),
  add('pinned', false),
]);`,
  'derive() into an optional field, which may be undefined': `
migration(V1, V2, ({ add, derive }) => [
  derive('status', () => 'want'),
  add('pinned', false),
  derive('rating', (c) => c.pages),
]);`,
  'the builder used without destructuring': `
migration(V1, V2, (s) => [s.derive('status', () => 'want'), s.add('pinned', false)]);`,
};

const refuses: Record<string, { code: number; message: string; snippet: string }> = {
  'derive() of free text into an enum': {
    code: 2322,
    message: `Type 'string' is not assignable to type '"want" | "reading" | "finished"'.`,
    snippet: `
migration(V1, V2, ({ add, derive }) => [
  derive('status', (c) => (c.status === 'done' ? 'finished' : c.status)),
  add('pinned', false),
]);`,
  },
  'derive() of a field the target does not declare': {
    code: 2345,
    message: `Argument of type '"stauts"' is not assignable to parameter of type '"title" | "status" | "pinned" | "rating"'.`,
    snippet: `
migration(V1, V2, ({ add, derive }) => [derive('stauts', () => 'want'), add('pinned', false)]);`,
  },
  "add() of a value the target's field refuses": {
    code: 2345,
    message: `Argument of type 'string' is not assignable to parameter of type 'boolean'.`,
    snippet: `
migration(V1, V2, ({ add, derive }) => [derive('status', () => 'want'), add('pinned', 'yes')]);`,
  },
  'derive() of undefined into a required field': {
    code: 2322,
    message: `Type 'undefined' is not assignable to type '"want" | "reading" | "finished"'.`,
    snippet: `
migration(V1, V2, ({ add, derive }) => [derive('status', () => undefined), add('pinned', false)]);`,
  },
  'derive() reading a field the source does not declare': {
    code: 2551,
    message: `Property 'titel' does not exist on type '{ title: string; status: string; pages?: number | undefined; }'. Did you mean 'title'?`,
    snippet: `
migration(V1, V2, ({ add, derive }) => [
  derive('status', () => 'want'),
  derive('title', (c) => c.titel),
  add('pinned', false),
]);`,
  },
};

type Diagnostic = { code: number; message: string };
const diagnostics = new Map<string, Diagnostic[]>();

beforeAll(() => {
  const config = ts.getParsedCommandLineOfConfigFile(
    join(root, 'tsconfig.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  )!;
  const cases = {
    ...compiles,
    ...Object.fromEntries(Object.entries(refuses).map(([name, { snippet }]) => [name, snippet])),
  };
  const files = new Map(
    Object.entries(cases).map(([name, snippet], i) => [
      join(root, `__migration-case-${i}.ts`),
      { name, text: prelude + snippet },
    ]),
  );
  const host = ts.createCompilerHost(config.options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (path) => files.get(path)?.text ?? readFile(path);
  host.fileExists = (path) => files.has(path) || fileExists(path);
  const program = ts.createProgram([...files.keys()], config.options, host);
  for (const [path, { name }] of files) {
    diagnostics.set(
      name,
      ts.getPreEmitDiagnostics(program, program.getSourceFile(path)).map((d) => ({
        code: d.code,
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      })),
    );
  }
}, 60_000);

describe('migration() steps, to the compiler', () => {
  test.each(Object.keys(compiles))('compiles: %s', (name) => {
    expect(diagnostics.get(name)).toEqual([]);
  });

  test.each(Object.entries(refuses))('refuses, in one error on one line: %s', (name, expected) => {
    expect(diagnostics.get(name)).toEqual([{ code: expected.code, message: expected.message }]);
  });
});
