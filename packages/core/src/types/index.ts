/**
 * Stack — Core Type Definitions
 * -------------------------------------------------------
 * The source of truth for all types in the Stack library, one module per
 * concern. No logic lives here — just shapes. Import from this barrel
 * rather than from a module, so a type can move without touching callers.
 */

export * from './ids.js';
export * from './associations.js';
export * from './records.js';
export * from './schema.js';
export * from './system.js';
export * from './query.js';
export * from './capabilities.js';
export * from './journal.js';
export * from './events.js';
export * from './adapter.js';
export * from './tokens.js';
