/**
 * Server-side state access.
 *
 * The main OmniClaw process sets the WebStateProvider on this module
 * before starting the SolidStart handler. API routes import getState()
 * to access orchestrator state.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _stateProvider: any = null;

/** Called by the main process to wire up state. */
export function setServerState(provider: unknown) {
  _stateProvider = provider;
}

/** Get the WebStateProvider. Throws if not initialized. */
export function getState(): any {
  if (!_stateProvider) throw new Error('Server state not initialized');
  return _stateProvider;
}
