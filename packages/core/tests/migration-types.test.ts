import { beforeAll, describe, expect, test } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// What the compiler says about a migration is part of its contract: a
// mistake in a declaration is one error, naming the field or type at fault.
// Each case is compiled against core's source under the package's own
// compiler options, never run.

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
    archived: { kind: 'boolean' },
    tags: { kind: 'array', items: { kind: 'enum', values: ['a', 'b'] } },
  },
});
const V2 = typeHandle({
  id: 'com.example.reading/book@2',
  name: 'Book',
  migratesFrom: V1,
  schema: {
    name: { kind: 'string', required: true },
    status: { kind: 'enum', values: ['want', 'reading', 'finished'], required: true },
    pinned: { kind: 'boolean', required: true },
    rating: { kind: 'number' },
    tags: { kind: 'array', items: { kind: 'enum', values: ['x', 'b'] } },
  },
});
type V1C = StoredContentOf<typeof V1.schema>;
`;

/** A declaration of V2's fields around `status`, each case's subject. */
const around = (status: string, rest = '') => `
migration(V1, V2, ({ fields, field, constant, derive }) =>
  fields({
    name: field('title'),
    status: ${status},
    pinned: constant(false),
    ${rest}
  }),
);`;

const compiles: Record<string, string> = {
  'derive() with a total conditional': around(
    `derive((c) => (c.status === 'done' ? 'finished' : 'want'))`,
  ),
  'derive() returning a constant':
    around(`derive(() => 'want')`) + around(`derive((_c) => 'want')`),
  'derive() with a switch body, a named function or an annotated parameter': `
function statusOf(c: V1C) {
  return c.status === 'done' ? ('finished' as const) : ('want' as const);
}
${around(`derive((c) => {
      switch (c.status) {
        case 'done':
          return 'finished';
        default:
          return 'want';
      }
    })`)}
${around('derive(statusOf)')}
${around(`derive((c: V1C) => (c.status === 'done' ? 'finished' : 'want'))`)}`,
  'derive() into an optional field, which may be undefined': around(
    `constant('want')`,
    `\n    rating: derive((c) => c.pages),`,
  ),
  'field() mapping into the target enum': around(
    `constant('want')`,
    `\n    tags: field('tags', { a: 'x' }),`,
  ),
  'the builder used without destructuring': `
migration(V1, V2, (b) =>
  b.fields({ name: b.field('title'), status: b.constant('want'), pinned: b.constant(false) }),
);`,
};

// A message that prints a content type is matched by pattern, since the
// order TypeScript prints a union's members in is not stable across
// programs. A message with no line break is one line.
const refuses: Record<string, { code: number; message: string | RegExp; snippet: string }> = {
  'derive() of free text into an enum': {
    code: 2322,
    message: `Type 'string' is not assignable to type '"want" | "reading" | "finished"'.`,
    snippet: around(`derive((c) => (c.status === 'done' ? 'finished' : c.status))`),
  },
  'a field the target does not declare': {
    code: 2561,
    message:
      /^Object literal may only specify known properties, but 'stauts' does not exist in type 'MigrationFields<[^\n]*>'\. Did you mean to write 'status'\?$/,
    snippet: around(`constant('want')`, `\n    stauts: constant('want'),`),
  },
  "a constant the target's field refuses": {
    code: 2345,
    message: `Argument of type 'string' is not assignable to parameter of type 'boolean'.`,
    snippet: around(`constant('want')`).replace('constant(false)', `constant('yes')`),
  },
  'constant() of undefined, which is no constant': {
    code: 2345,
    message: `Argument of type 'undefined' is not assignable to parameter of type 'number'.`,
    snippet: around(`constant('want')`, `\n    rating: constant(undefined),`),
  },
  'derive() of undefined into a required field': {
    code: 2322,
    message: `Type 'undefined' is not assignable to type '"want" | "reading" | "finished"'.`,
    snippet: around(`derive(() => undefined)`),
  },
  'derive() reading a field the source does not declare': {
    code: 2551,
    message:
      /^Property 'titel' does not exist on type '{ title: string; [^\n]* }'\. Did you mean 'title'\?$/,
    snippet: around(`derive((c) => c.titel)`),
  },
  'field() reading a field the source does not declare': {
    code: 2345,
    message: `Argument of type '"titel"' is not assignable to parameter of type '"title" | "status" | "pages" | "archived" | "tags"'.`,
    snippet: around(`constant('want')`).replace(`field('title')`, `field('titel')`),
  },
  "field() mapping to a value the target's enum does not list": {
    code: 2322,
    message:
      /^Type 'Origin<\("b" \| "y"\)\[\] \| undefined>' is not assignable to type 'Origin<\("b" \| "x"\)\[\] \| undefined>'\.\n[^]*Type '"y"' is not assignable to type '"b" \| "x"'\.$/,
    snippet: around(`constant('want')`, `\n    tags: field('tags', { a: 'y' }),`),
  },
  "field() carrying a value the target's enum does not list": {
    code: 2322,
    message:
      /^Type 'Origin<\("a" \| "b"\)\[\] \| undefined>' is not assignable to type 'Origin<\("b" \| "x"\)\[\] \| undefined>'\.\n[^]*Type '"a"' is not assignable to type '"b" \| "x"'\.$/,
    snippet: around(`constant('want')`, `\n    tags: field('tags'),`),
  },
  'field() carrying a different kind': {
    code: 2322,
    message: /^Type 'Origin<number \| undefined>' is not assignable to type 'Origin<string>'\.\n/,
    snippet: around(`constant('want')`).replace(`field('title')`, `field('pages')`),
  },
  'field() carrying free text into an enum': {
    code: 2322,
    message:
      /^Type 'Origin<string>' is not assignable to type 'Origin<"want" \| "reading" \| "finished">'\.\n/,
    snippet: around(`field('status')`),
  },
  'field() mapping a value the source does not list': {
    code: 2353,
    message: `Object literal may only specify known properties, and 'c' does not exist in type 'Readonly<Partial<Record<"a" | "b", string>>>'.`,
    snippet: around(`constant('want')`, `\n    tags: field('tags', { c: 'x' }),`),
  },
  'a field only the source declares': {
    code: 2353,
    message:
      /^Object literal may only specify known properties, and 'archived' does not exist in type 'MigrationFields<[^\n]*>'\.$/,
    snippet: around(`constant('want')`, `\n    archived: drop(),`).replace(
      '({ fields, field, constant, derive })',
      '({ fields, field, constant, derive, drop })',
    ),
  },
  'a required field the source cannot carry, left undeclared': {
    code: 2345,
    message:
      /^Argument of type '[^\n]*' is not assignable to parameter of type 'MigrationFields<[^\n]*>'\.\n {2}Property 'pinned' is missing in type '[^\n]*' but required in type '[^\n]*'\.$/,
    snippet: around(`constant('want')`).replace('pinned: constant(false),', ''),
  },
  'drop() of a required field': {
    code: 2322,
    message: `Type 'Origin<undefined>' is not assignable to type 'Origin<"want" | "reading" | "finished">'.\n  Type 'undefined' is not assignable to type '"want" | "reading" | "finished"'.`,
    snippet: around('drop()').replace(
      '({ fields, field, constant, derive })',
      '({ fields, field, constant, derive, drop })',
    ),
  },
  'an origin the builder did not make': {
    code: 2353,
    message: `Object literal may only specify known properties, and 'kind' does not exist in type 'Origin<"want" | "reading" | "finished">'.`,
    snippet: around(`{ kind: 'constant', value: 'want' }`),
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

describe('migration() fields, to the compiler', () => {
  test.each(Object.keys(compiles))('compiles: %s', (name) => {
    expect(diagnostics.get(name)).toEqual([]);
  });

  test.each(Object.entries(refuses))('refuses, in one error: %s', (name, expected) => {
    const found = diagnostics.get(name)!;
    expect(found.map((d) => d.code)).toEqual([expected.code]);
    if (typeof expected.message === 'string') expect(found[0].message).toBe(expected.message);
    else expect(found[0].message).toMatch(expected.message);
  });
});
