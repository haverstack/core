import type { WireRecord } from '@haverstack/wire-types';
import type { ConformanceFixture } from './types.js';

export const commitMigrationFixtures: ConformanceFixture<
  { toTypeId: string; content: Record<string, unknown> },
  WireRecord
>[] = [
  {
    name: 'commit-migration',
    description:
      'POST /records/:id/migrate is the only way typeId changes after creation. Body carries ' +
      "the full post-migration content (computed client-side by the type's owning app); the " +
      "server validates it against toTypeId's schema before writing.",
    method: 'POST',
    path: '/records/1hk153x00001/migrate',
    requestBody: { toTypeId: 'com.example/note@2', content: { title: 'Hello', pinned: false } },
    responseStatus: 200,
    responseBody: {
      id: '1hk153x00001',
      typeId: 'com.example/note@2',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-05T00:00:00.000Z',
      content: { title: 'Hello', pinned: false },
      version: 5,
    },
  },
];
