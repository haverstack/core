/**
 * @haverstack/adapter-api
 * -------------------------------------------------------
 * A StackAdapter over HTTP, for a stack served by a remote server. One
 * module per layer: the adapter itself, the transport rules every request
 * shares, the wire parsers, search-parameter encoding, the change feed's
 * SSE decoder, and the authentication handshake. See
 * docs/spec/wire-format.md.
 */

export { APIAdapter } from './adapter.js';
export type { APIAdapterOpenOptions, InstallRequestResult } from './adapter.js';

export {
  APIAdapterError,
  APIAdapterAuthError,
  APIAdapterConnectionError,
  APIAdapterCapabilityError,
  APIAdapterVersionError,
  APIAdapterHandshakeError,
  APIAdapterReauthError,
  APIAdapterInsecureUrlError,
  APIAdapterAuthUnsupportedError,
} from './errors.js';
