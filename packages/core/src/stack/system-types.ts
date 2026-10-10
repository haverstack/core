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

export const SYSTEM_TYPE_DEFINITIONS: readonly DefineTypeOptions[] = [
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
      // Required, and closed: a Grant's reach is spelled by its `grantee`,
      // so a record arriving without one is refused here rather than read
      // as a grant to every authenticated entity. The arms differ in which
      // fields they carry, which a schema cannot express — evaluation reads
      // the `kind` and confers nothing on one it does not recognize.
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
      // Deliberately `string`, not `file-ref`: referencesFileId matching
      // (deleteAttachment()/collectAttachmentGarbage()'s reference scan) is
      // schema-driven, so a `file-ref` fileId here would make every
      // metadata record its own file's reference — nothing would ever be
      // deletable or collectible. See docs/spec/attachments.md § Deleting
      // attachments / Garbage collection.
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
