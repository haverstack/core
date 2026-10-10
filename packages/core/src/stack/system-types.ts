/**
 * System Type definitions
 * -------------------------------------------------------
 * The schemas of the `_`-prefixed Types every stack carries, defined by
 * Stack.open() before anything else touches the stack. They are data, not
 * behaviour: the rules each family is held to live in the Stack write path
 * and in ScopedStack, which key on the family rather than on these
 * schemas. See docs/spec/data-model.md § System types.
 */

import { SYSTEM_TYPES } from '../types/index.js';
import type { DefineTypeOptions } from './client.js';

/**
 * Built afresh on each call, so no two Stacks share a schema object:
 * defineType() caches the one it is handed by reference.
 */
export const systemTypeDefinitions = (): DefineTypeOptions[] => [
  {
    id: `${SYSTEM_TYPES.CONFIG}@1`,
    name: 'Config',
    schema: {
      entityId: { kind: 'string', required: true },
      // Optional passthrough app metadata — see ConfigContent.timezone.
      timezone: { kind: 'string' },
    },
  },
  {
    id: `${SYSTEM_TYPES.ENTITY}@1`,
    name: 'Entity',
    schema: {
      did: { kind: 'string', required: true },
      name: { kind: 'string', required: true },
      handle: { kind: 'string' },
    },
  },
  {
    id: `${SYSTEM_TYPES.APP}@1`,
    name: 'App',
    schema: {
      appId: { kind: 'string', required: true },
      name: { kind: 'string', required: true },
      version: { kind: 'string' },
      did: { kind: 'string' },
    },
  },
  {
    id: `${SYSTEM_TYPES.GROUP}@1`,
    name: 'Group',
    schema: {
      name: { kind: 'string', required: true },
      handle: { kind: 'string' },
      stackUrl: { kind: 'string' },
    },
  },
  {
    id: `${SYSTEM_TYPES.GRANT}@1`,
    name: 'Grant',
    schema: {
      baseId: { kind: 'string', required: true },
      actions: { kind: 'array', items: { kind: 'string' }, required: true },
      // Required, so a grant without one is refused rather than read as a
      // grant to every authenticated entity. The arms' differing fields are
      // beyond a schema; evaluation confers nothing on an unknown `kind`.
      // See docs/spec/access-control.md § Type-level grants.
      grantee: {
        kind: 'object',
        required: true,
        properties: {
          kind: { kind: 'string', required: true },
          entityId: { kind: 'string' },
          groupId: { kind: 'string' },
          role: { kind: 'string' },
        },
      },
    },
  },
  {
    id: `${SYSTEM_TYPES.ATTACHMENT}@1`,
    name: 'Attachment',
    schema: {
      // `string`, not `file-ref`: reference matching is schema-driven, so a
      // `file-ref` here would make every metadata record a reference to its
      // own file, and nothing would ever be deletable or collectible.
      // See docs/spec/attachments.md § Garbage collection.
      fileId: { kind: 'string', required: true },
      mimeType: { kind: 'string', required: true },
      size: { kind: 'number', required: true },
      filename: { kind: 'string' },
    },
  },
  {
    id: `${SYSTEM_TYPES.INSTALL}@1`,
    name: 'Install',
    schema: {
      appId: { kind: 'string', required: true },
      name: { kind: 'string', required: true },
      version: { kind: 'string' },
      defines: { kind: 'array', items: { kind: 'string' }, required: true },
      requests: {
        kind: 'array',
        required: true,
        items: {
          kind: 'object',
          properties: {
            baseId: { kind: 'string', required: true },
            actions: { kind: 'array', items: { kind: 'string' }, required: true },
          },
        },
      },
    },
  },
];
