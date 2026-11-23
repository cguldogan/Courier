/**
 * Azure identity for the command-line runner: the app's `IdentityService` (managed identity, Azure
 * CLI, or automatic = managed identity then Azure CLI; never a browser), signed in lazily: only when
 * something needs a token (team download, a Key Vault reference, Azure identity auth). One sign-in
 * per run; a failure is remembered, so the run can stop with exit code 2 instead of reporting the same
 * failure for every request. Nothing is cached on disk by Courier.
 */
import type { AccessToken, GetTokenOptions, TokenCredential } from '@azure/core-auth'
import { IdentityService, type FakeIdentity } from '../main/azure'
import { Fault, messageOf } from '../main/errors'
import type { EntraTokenSource } from '../main/executor'
import type { IdentityAccount, IdentitySettings } from '../shared/types'

export type CliIdentityMode = 'auto' | 'managed-identity' | 'azure-cli'

export interface CliIdentityOptions {
  mode: CliIdentityMode
  /** User-assigned managed identity (client id). */
  clientId?: string
  /** Tenant for the Azure CLI credential. */
  tenant?: string
}

export function identitySettings(o: CliIdentityOptions): IdentitySettings {
  return {
    mode: o.mode,
    ...(o.clientId ? { managedIdentityClientId: o.clientId } : {}),
    ...(o.tenant ? { tenantId: o.tenant } : {})
  }
}

export class CliIdentity {
  private readonly service: IdentityService
  private signing: Promise<void> | null = null
  /** Set when sign-in failed (the run stops with exit code 2). */
  failure: Fault | null = null
  /** Called once, when sign-in fails. */
  onFailure: (f: Fault) => void = () => {}
  readonly tokens: EntraTokenSource
  private readonly cred: TokenCredential

  constructor(
    private readonly options: CliIdentityOptions,
    fake: FakeIdentity | null,
    /** Registers each acquired token with the run's masker. */
    private readonly onToken: (token: string) => void = () => {}
  ) {
    this.service = new IdentityService({ mode: options.mode }, fake)
    this.tokens = {
      getToken: async (scope: string) => {
        await this.ensure()
        const t = await this.service.getToken(scope)
        this.onToken(t)
        return t
      }
    }
    const inner = this.service.credential()
    this.cred = {
      getToken: async (scopes: string | string[], opts?: GetTokenOptions): Promise<AccessToken | null> => {
        await this.ensure()
        const t = await inner.getToken(scopes, opts)
        if (t) this.onToken(t.token)
        return t
      }
    }
  }

  get attempted(): boolean {
    return this.signing !== null
  }

  account(): IdentityAccount | null {
    return this.service.account()
  }

  /** Signs in on first use; later calls share the result. */
  ensure(): Promise<void> {
    if (!this.signing) {
      this.signing = this.service.signIn(identitySettings(this.options)).then(
        () => undefined,
        (err: unknown) => {
          const f = err instanceof Fault ? err : new Fault('AUTH_FAILED', messageOf(err))
          this.failure = new Fault(f.code, `Azure sign-in (${this.options.mode}) failed: ${f.message}`)
          this.onFailure(this.failure)
          throw this.failure
        }
      )
      this.signing.catch(() => undefined)
    }
    return this.signing
  }

  /** A TokenCredential for the storage and Key Vault SDKs that signs in on first use. */
  credential(): TokenCredential {
    return this.cred
  }
}
