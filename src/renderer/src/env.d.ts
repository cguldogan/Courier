import type { CourierApi } from '../../shared/api'

declare global {
  interface Window {
    /** Exposed by src/preload/index.ts — see src/shared/api.ts for the contract. */
    courier: CourierApi
  }
}

export {}
