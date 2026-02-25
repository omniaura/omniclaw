/**
 * Shared dummy ContainerProcess for cloud backends that don't have real PIDs.
 * Used by Railway, Hetzner, and similar S3-based backends.
 */

import { ContainerProcess } from '../types.js';

export class CloudProcessWrapper implements ContainerProcess {
  private _killed = false;

  get killed(): boolean { return this._killed; }
  kill(): void { this._killed = true; }
  get pid(): number { return 0; }
}
