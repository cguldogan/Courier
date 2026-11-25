export interface SelfSignedOptions {
  /** Validity in days (default 2). */
  days?: number
  /** Add DNS:localhost to the subjectAltName (default true; IP:127.0.0.1 is always there). */
  dns?: boolean
}
export function selfSignedCert(opts?: SelfSignedOptions): { certPem: string; keyPem: string }
export function writeSelfSignedCert(certPath: string, keyPath: string, opts?: SelfSignedOptions): void
