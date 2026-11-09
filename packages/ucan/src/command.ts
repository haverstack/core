/**
 * UCAN commands: lowercase, slash-delimited paths, where a shorter command
 * proves every command nested under it and `/` proves them all.
 */

export const isValidCommand = (cmd: unknown): cmd is string =>
  typeof cmd === 'string' && cmd === cmd.toLowerCase() && (cmd === '/' || /^(\/[^/]+)+$/.test(cmd));

/** Whether a delegated command proves `invoked`: `/crypto` proves `/crypto/sign`, never `/cryptocurrency`. */
export const commandCovers = (delegated: string, invoked: string): boolean =>
  delegated === '/' || invoked === delegated || invoked.startsWith(`${delegated}/`);
