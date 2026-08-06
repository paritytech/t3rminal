/**
 * Host account management
 *
 * Two paths:
 *
 *  1. **Product account** (`getProductAccount(identifier, 0)`) — preferred.
 *     Polkadot Desktop ≥ 0.7.5 (commit 835a3a9) accepts both `.dot` domains
 *     and `localhost:PORT` identifiers, so this works in both prod and dev.
 *     Goes through the non-legacy `signPayload` host slot, which is the only
 *     end-to-end-functional signing path on the desktop today.
 *
 *  2. **Legacy account** (`getLegacyAccounts`) — kept as fallback for hosts
 *     that don't yet ship the localhost-identifier feature, or 0.6.x hosts.
 *     The legacy `signPayloadWithLegacyAccount` slot is still flagged as a
 *     stub in the desktop integration (TODO comment), so signing through it
 *     does not reliably reach the phone.
 */

"use client"

import { AccountId } from "polkadot-api"
import type { PolkadotSigner } from "polkadot-api"
import type { Account } from "@/lib/web3/types/web3"
import { WalletProviderType } from "@/lib/web3/types/web3"
import type { ProductAccount } from "@parity/product-sdk/host"
import { getAccountsProvider } from "./connection"

export interface HostAccount extends Account {
  polkadotSigner: PolkadotSigner
  publicKey: Uint8Array
}

const accountIdCodec = AccountId()

/**
 * The identifier the host uses to scope our product (dotNS hostname or
 * localhost:PORT). Read from `window.location.host` — matches what
 * `parseLocalhostUrl` / `parseDotNsUrl` produce on the desktop side.
 */
function getProductIdentifier(): string | null {
  if (typeof window === "undefined") return null
  return window.location.host || null
}

/** Race a promise against a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ])
}

/**
 * Try the product-account path: accountsProvider.getProductAccount(identifier, 0).
 * Returns a single derived account whose signer goes through the host's
 * non-legacy `signPayload` slot.
 */
async function tryProductAccount(): Promise<HostAccount[] | null> {
  const identifier = getProductIdentifier()
  if (!identifier) return null

  const provider = await getAccountsProvider()
  if (!provider) return null

  try {
    console.log(`[Host Accounts] Trying getProductAccount("${identifier}", 0)...`)
    const result = await withTimeout(
      Promise.resolve(provider.getProductAccount(identifier, 0)),
      5000,
      "getProductAccount"
    )

    return result.match(
      (account: ProductAccount) => {
        const address = accountIdCodec.dec(account.publicKey)
        console.log(`[Host Accounts] Product account: ${address} (identifier=${identifier})`)
        // `createTransaction` slot — host receives full extension bytes (extra +
        // additionalSigned) from PAPI's tx-utils, forwards to the phone wallet.
        // Phone reconstructs the extrinsic from its own runtime metadata for
        // chain-known extensions (AsPgas → BANDERSNATCH membership proof,
        // EthSetOrigin → EVM origin, etc) and signs the v5 transaction.
        // Requires Polkadot Desktop ≥ 0.3.10 and polkadot-app-android-v2.
        return [{
          name: `T3rminal merchant`,
          address,
          provider: WalletProviderType.HostAPI,
          polkadotSigner: provider.getProductAccountSigner(account),
          publicKey: account.publicKey,
        }] satisfies HostAccount[]
      },
      (err: unknown) => {
        console.warn("[Host Accounts] getProductAccount error:", JSON.stringify(err))
        return null
      },
    )
  } catch (e: any) {
    console.warn("[Host Accounts] getProductAccount failed:", e?.message || e)
    return null
  }
}

/**
 * Try the 0.7.x path: accountsProvider.getLegacyAccounts()
 */
async function tryLegacyAccounts(): Promise<HostAccount[] | null> {
  const provider = await getAccountsProvider()
  if (!provider) return null

  try {
    console.log("[Host Accounts] Trying getLegacyAccounts (0.7.x)...")
    const result = await withTimeout(
      Promise.resolve(provider.getLegacyAccounts()),
      5000,
      "getLegacyAccounts"
    )

    return result.match(
      (accounts) => {
        if (accounts.length === 0) {
          console.log("[Host Accounts] getLegacyAccounts returned empty")
          return [] as HostAccount[]
        }
        console.log(`[Host Accounts] Got ${accounts.length} legacy account(s)`)
        return accounts.map((acc) => {
          const address = accountIdCodec.dec(acc.publicKey)
          console.log(`[Host Accounts] Account: ${acc.name || "unnamed"} ${address}`)
          return {
            name: acc.name || "Host Account",
            address,
            provider: WalletProviderType.HostAPI,
            polkadotSigner: provider.getLegacyAccountSigner({ publicKey: acc.publicKey }),
            publicKey: acc.publicKey,
          }
        })
      },
      (err: unknown) => {
        console.warn("[Host Accounts] getLegacyAccounts error:", JSON.stringify(err))
        return null
      },
    )
  } catch (e: any) {
    console.warn("[Host Accounts] getLegacyAccounts failed:", e?.message || e)
    return null
  }
}

export async function getHostAccounts(): Promise<HostAccount[]> {
  // Product account is the only signing path that goes end-to-end on the
  // current host-api 0.8.x protocol (Polkadot Desktop ≥0.7.5 + Android v2).
  // The legacy `signPayloadWithLegacyAccount` slot is an explicit stub that
  // rejects every request not derived from the product account, so legacy
  // accounts are returned only for UI display (e.g. Coinage receive address).
  const productResult = await tryProductAccount()
  if (productResult !== null && productResult.length > 0) return productResult
  return (await tryLegacyAccounts()) ?? []
}

export async function subscribeHostAccounts(
  onAccountsChanged: (accounts: HostAccount[]) => void
): Promise<() => void> {
  const provider = await getAccountsProvider()
  if (!provider) return () => {}

  const sub = provider.subscribeAccountConnectionStatus(async (status) => {
    if (status === "Connected") {
      const accounts = await getHostAccounts()
      onAccountsChanged(accounts)
    } else {
      onAccountsChanged([])
    }
  })

  return () => sub.unsubscribe()
}
