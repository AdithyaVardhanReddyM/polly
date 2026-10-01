import type { PollyBridge } from '../../shared/contracts'

declare global {
  interface Window {
    /** Present inside Electron only; the web build talks to the server directly. */
    polly?: PollyBridge
  }
}

export {}
