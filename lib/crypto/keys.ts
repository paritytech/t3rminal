/**
 * X25519 Encryption Keypair Management
 *
 * When running inside a host (Polkadot Desktop / dot.li), the keypair is
 * derived deterministically from the user's wallet account via the host's
 * Ring VRF contextual alias: `accountsProvider.getProductAccountAlias(context,
 * location)`. The host derives the alias for the user's member key in the
 * people-lite ring on the Individuality chain, bound to a product-scoped
 * context (productId + suffix). The alias is deterministic in (wallet member
 * key, context, ring), so the same wallet on any device gives the same alias
 * and therefore the same encryption keypair (cross-device portable).
 *
 * We intentionally do NOT use `deriveEntropy` here: the desktop host's
 * `secrets.entropy` is a per-SSO-pairing random value, not derived from the
 * user's wallet, so two devices paired with the same wallet get different
 * `deriveEntropy` outputs. The contextual alias goes through the phone's
 * wallet ring member key instead, which IS shared across devices (same
 * imported mnemonic).
 *
 * See `buildAliasRequest` below for the (context, location) construction and an
 * important decryption-compatibility caveat.
 *
 * Standalone (dev) mode falls back to a random keypair in memory.
 */

"use client"

import { nacl } from "@/lib/crypto/primitives"
import { hostLocalStorage } from "@novasamatech/host-api-wrapper"
import { getAccountsProvider } from "@/lib/host/connection"
import type { ProductProofContext, RingLocation } from "@parity/product-sdk/host"
import { PASEO_INDIVIDUALITY_GENESIS } from "@/lib/host/provider"

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

const STORAGE_KEY = "encryption_keypair"
const RECIPIENTS_KEY = "encryption_recipients"

/**
 * Get the product identifier used by the host to scope account derivation.
 * The host uses this same value as productId when phone computes the alias —
 * keep in sync with lib/host/accounts.ts:getProductIdentifier().
 */
function getProductIdentifier(): string | null {
  if (typeof window === "undefined") return null
  return window.location.host || null
}

export interface EncryptionKeypair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export interface Recipient {
  id: string
  name: string
  pubkeyHex: string
  addedAt: string
  isOwn: boolean  // true = this terminal's own key
}

/** Generate a random X25519 encryption keypair (standalone fallback) */
export function generateKeypair(): EncryptionKeypair {
  const kp = nacl.box.keyPair()
  return { publicKey: kp.publicKey, secretKey: kp.secretKey }
}

// ── Deterministic derivation from host account ──────────────────

/**
 * Ring VRF location + context for the wallet-bound contextual alias.
 *
 * The new host API (`@parity/product-sdk/host` >= 0.14) derives the alias as a
 * Ring VRF over the user's member key in a ring, addressed by a
 * {@link RingLocation} (`{ chainId, junctions }`) and bound to a
 * {@link ProductProofContext} (`{ productId, suffix }`). We follow the
 * canonical people-lite ring construction used by the reference consumers (the
 * TruAPI playground example and `@parity/product-sdk-signer`):
 *
 *   context  = { productId: window.location.host, suffix: { tag: "Left", value: 0 } }
 *   location = { chainId: Individuality genesis,
 *                junctions: [ PalletInstance(67),
 *                             CollectionId("pop:polkadot.network/people-lite") ] }
 *
 * WARNING - SEMANTIC-EQUIVALENCE / DECRYPTION-COMPAT ASSUMPTION, NEEDS
 * SDK-TEAM (Nidish) VERIFICATION: the previous code called the old two-arg
 * primitive `getProductAccountAlias(identifier, 0)` (product-sdk 0.7.x), whose
 * byte derivation is not reproducible from the sources in this repo. The alias
 * bytes produced by THIS (context, location) are only guaranteed to match old
 * data if the old derivation used the same ring and the same product/suffix
 * mapping (suffix Left(0) for index 0). If it did not, data encrypted under the
 * old key will NOT decrypt. Verify before relying on cross-device decryption of
 * any pre-migration data.
 */
const PEOPLE_LITE_PALLET_INSTANCE = 67
// hex("pop:polkadot.network/people-lite") - the proof-of-personhood ring collection.
const PEOPLE_LITE_COLLECTION_ID =
  "0x706f703a706f6c6b61646f742e6e6574776f726b2f70656f706c652d6c697465" as `0x${string}`
// Product-account derivation index. Host 0.15 types the context suffix as a
// tagged DerivationIndex selector; Left(0) is the plain index-0 form (old index 0).
const ALIAS_CONTEXT_SUFFIX: ProductProofContext["suffix"] = { tag: "Left", value: 0 }

function buildAliasRequest(identifier: string): {
  context: ProductProofContext
  location: RingLocation
} {
  return {
    context: { productId: identifier, suffix: ALIAS_CONTEXT_SUFFIX },
    location: {
      chainId: PASEO_INDIVIDUALITY_GENESIS,
      junctions: [
        { tag: "PalletInstance", value: PEOPLE_LITE_PALLET_INSTANCE },
        { tag: "CollectionId", value: PEOPLE_LITE_COLLECTION_ID },
      ],
    },
  }
}

/** Extract a human-readable reason from a host alias-call error envelope. */
function aliasErrorReason(err: unknown): string {
  const e = err as { payload?: { reason?: string }; value?: { reason?: string }; message?: string }
  return e?.payload?.reason ?? e?.value?.reason ?? e?.message ?? String(err)
}

/**
 * Derive a deterministic X25519 keypair from the user's wallet via the host's
 * Ring VRF contextual alias (`getProductAccountAlias(context, location)`, see
 * {@link buildAliasRequest}). The alias is deterministic in (wallet member key,
 * context, ring), so the same wallet (mnemonic) yields the same keypair on any
 * device.
 *
 * Returns null ONLY in standalone (non-host) mode, the legitimate fallback to a
 * random/cached keypair. When running inside a host we MUST be able to derive
 * the wallet-bound key: any failure (provider unavailable, no product
 * identifier, host error, unexpected alias shape) THROWS rather than silently
 * degrading to a different key that cannot decrypt cross-device data.
 */
async function deriveFromAccountAlias(): Promise<EncryptionKeypair | null> {
  const { isInHost } = await import("@/lib/host/detect")
  if (!isInHost()) return null // standalone dev: fall back to random/cached

  const identifier = getProductIdentifier()
  if (!identifier) {
    throw new Error(
      "[Crypto] cannot derive account alias in host: no product identifier (window.location.host)"
    )
  }

  const provider = await getAccountsProvider()
  if (!provider) {
    throw new Error("[Crypto] cannot derive account alias: accounts provider unavailable in host")
  }

  const { context, location } = buildAliasRequest(identifier)
  const alias = await provider.getProductAccountAlias(context, location).match(
    (contextualAlias) => contextualAlias.alias,
    (err) => {
      throw new Error(
        `[Crypto] getProductAccountAlias failed - cross-device decryption WILL FAIL: ${aliasErrorReason(err)}`
      )
    }
  )

  if (alias.length !== 32) {
    // nacl.box (X25519) requires a 32-byte secret key. A different length means
    // the ring/alias shape is not what this seed derivation assumes.
    throw new Error(
      `[Crypto] account alias has unexpected length ${alias.length} (expected 32-byte X25519 seed)`
    )
  }

  const kp = nacl.box.keyPair.fromSecretKey(alias)
  console.log(
    `[Crypto] Derived deterministic keypair from wallet alias: 0x${bytesToHex(kp.publicKey)}`
  )
  return { publicKey: kp.publicKey, secretKey: kp.secretKey }
}

// ── Storage helpers (cache / standalone fallback) ───────────────

async function getStorage() {
  const { isInHost } = await import("@/lib/host/detect")
  if (isInHost()) return hostLocalStorage
  // Memory fallback for dev
  const mem: Record<string, any> = (globalThis as any).__cryptoStore ??= {}
  return {
    readJSON: async (k: string) => mem[k] ?? null,
    writeJSON: async (k: string, v: unknown) => { mem[k] = v; return undefined },
    clear: async (k: string) => { delete mem[k]; return undefined },
  }
}

// ── Keypair persistence ─────────────────────────────────────────

/** Load keypair from storage cache */
async function loadFromCache(): Promise<EncryptionKeypair | null> {
  try {
    const storage = await getStorage()
    const data = await storage.readJSON(STORAGE_KEY)
    if (!data?.publicKey || !data?.secretKey) return null
    return {
      publicKey: hexToBytes(data.publicKey),
      secretKey: hexToBytes(data.secretKey),
    }
  } catch {
    return null
  }
}

/** Save keypair to storage cache */
async function saveToCache(kp: EncryptionKeypair): Promise<void> {
  const storage = await getStorage()
  await storage.writeJSON(STORAGE_KEY, {
    publicKey: bytesToHex(kp.publicKey),
    secretKey: bytesToHex(kp.secretKey),
  })
}

/**
 * Load this account's keypair.
 *
 * In host mode: derives deterministically from the user's wallet via
 * `getProductAccountAlias` (cross-device portable). Falls back to cache if
 * alias retrieval fails. In standalone mode: reads from memory cache,
 * returns null if none.
 */
export async function loadKeypair(): Promise<EncryptionKeypair | null> {
  // Try deterministic derivation first (wallet-bound, cross-device portable)
  const derived = await deriveFromAccountAlias()
  if (derived) {
    await saveToCache(derived)
    return derived
  }

  // Fallback to cache (offline / alias unavailable)
  return loadFromCache()
}

/** @deprecated Use loadKeypair() — kept for backward compat */
export async function saveKeypair(kp: EncryptionKeypair): Promise<void> {
  await saveToCache(kp)
}

/**
 * Get this account's keypair, creating one if necessary.
 *
 * Priority:
 *   1. `getProductAccountAlias` (deterministic, wallet-bound, cross-device)
 *   2. Cached keypair from storage
 *   3. Random keypair (standalone dev only)
 */
export async function getOrCreateKeypair(): Promise<EncryptionKeypair> {
  // Try deterministic derivation (same wallet → same keypair on any device)
  const derived = await deriveFromAccountAlias()
  if (derived) {
    await saveToCache(derived)
    return derived
  }

  // Fallback: cache or generate random (standalone)
  const cached = await loadFromCache()
  if (cached) return cached

  const kp = generateKeypair()
  await saveToCache(kp)
  console.log("[Crypto] Generated random keypair (standalone):", bytesToHex(kp.publicKey).slice(0, 16) + "...")
  return kp
}

// ── Recipients management ───────────────────────────────────────

/** Load the recipients list */
export async function loadRecipients(): Promise<Recipient[]> {
  try {
    const storage = await getStorage()
    const data = await storage.readJSON(RECIPIENTS_KEY)
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

/** Save the recipients list */
export async function saveRecipients(recipients: Recipient[]): Promise<void> {
  const storage = await getStorage()
  await storage.writeJSON(RECIPIENTS_KEY, recipients)
}

/** Ensure this terminal is in the recipients list */
export async function ensureSelfInRecipients(): Promise<Recipient[]> {
  const kp = await getOrCreateKeypair()
  const pubHex = bytesToHex(kp.publicKey)
  const recipients = await loadRecipients()

  const selfExists = recipients.some((r) => r.pubkeyHex === pubHex)
  if (selfExists) return recipients

  const self: Recipient = {
    id: crypto.randomUUID(),
    name: "This Terminal",
    pubkeyHex: pubHex,
    addedAt: new Date().toISOString(),
    isOwn: true,
  }
  const updated = [self, ...recipients]
  await saveRecipients(updated)
  console.log("[Crypto] Added self to recipients list")
  return updated
}

/** Add a new recipient by pubkey hex */
export async function addRecipient(name: string, pubkeyHex: string): Promise<Recipient[]> {
  const clean = pubkeyHex.replace(/^0x/, "").toLowerCase()
  if (clean.length !== 64) throw new Error("Public key must be 32 bytes (64 hex chars)")

  // Validate it's valid hex
  hexToBytes(clean)

  const recipients = await loadRecipients()
  if (recipients.some((r) => r.pubkeyHex === clean)) {
    throw new Error("This public key is already in the recipients list")
  }

  const recipient: Recipient = {
    id: crypto.randomUUID(),
    name,
    pubkeyHex: clean,
    addedAt: new Date().toISOString(),
    isOwn: false,
  }
  const updated = [...recipients, recipient]
  await saveRecipients(updated)
  return updated
}

/** Remove a recipient by id */
export async function removeRecipient(id: string): Promise<Recipient[]> {
  const recipients = await loadRecipients()
  const updated = recipients.filter((r) => r.id !== id)
  await saveRecipients(updated)
  return updated
}

// ── Diagnostics ──────────────────────────────────────────────────

export type KeypairSource = "derived" | "cached" | "fresh-random" | "none"

export interface KeypairDiagnostics {
  /** Hex-encoded public key (with 0x prefix), if any. */
  pubkeyHex: string | null
  /** Where the key came from for the current session. */
  source: KeypairSource
  /** Whether the app is running inside a host (Polkadot Desktop / dot.li). */
  inHost: boolean
  /** Whether `deriveEntropy` succeeded against the host. */
  deriveEntropyAvailable: boolean
  /** Error reason from deriveEntropy if it failed. */
  deriveEntropyError: string | null
  /** The window.location.host value visible to the app — host scopes derivation by this. */
  windowHost: string | null
  /** Blake2b-256 hex digest of the raw entropy seed returned by deriveEntropy. */
  seedHash: string | null
}

/**
 * Diagnostic helper — reports the state of the encryption keypair without
 * mutating it. Useful from devtools to compare two devices that should map
 * to the same account.
 *
 * Open devtools and run:
 *   import("/lib/crypto/keys").then(m => m.inspectKeypair()).then(console.log)
 */
export async function inspectKeypair(): Promise<KeypairDiagnostics> {
  const { isInHost } = await import("@/lib/host/detect")
  const inHost = isInHost()
  const { blake2b } = await import("@noble/hashes/blake2.js")

  const windowHost = typeof window !== "undefined" ? window.location.host : null
  const identifier = getProductIdentifier()

  let deriveEntropyAvailable = false
  let deriveEntropyError: string | null = null
  let derivedPubHex: string | null = null
  let seedHash: string | null = null

  if (inHost && identifier) {
    // Diagnostic only: capture failures into `deriveEntropyError` (this helper
    // reports state without mutating it), unlike deriveFromAccountAlias which
    // throws on the live crypto path.
    try {
      const provider = await getAccountsProvider()
      if (!provider) {
        deriveEntropyError = "accounts provider unavailable in host"
      } else {
        const { context, location } = buildAliasRequest(identifier)
        await provider.getProductAccountAlias(context, location).match(
          (contextualAlias) => {
            const alias = contextualAlias.alias
            if (alias.length === 32) {
              // Hash the alias so we can compare across devices without leaking it.
              seedHash = `0x${bytesToHex(blake2b(alias, { dkLen: 32 }))}`
              const kp = nacl.box.keyPair.fromSecretKey(alias)
              derivedPubHex = `0x${bytesToHex(kp.publicKey)}`
              deriveEntropyAvailable = true
            } else {
              deriveEntropyError = `alias has unexpected length ${alias.length}`
            }
          },
          (err: unknown) => {
            deriveEntropyError = aliasErrorReason(err)
          }
        )
      }
    } catch (e: unknown) {
      deriveEntropyError = e instanceof Error ? e.message : String(e)
    }
  }

  if (derivedPubHex) {
    return {
      pubkeyHex: derivedPubHex,
      source: "derived",
      inHost,
      deriveEntropyAvailable,
      deriveEntropyError,
      windowHost,
      seedHash,
    }
  }

  const cached = await loadFromCache()
  if (cached) {
    return {
      pubkeyHex: `0x${bytesToHex(cached.publicKey)}`,
      source: "cached",
      inHost,
      deriveEntropyAvailable,
      deriveEntropyError,
      windowHost,
      seedHash,
    }
  }

  return {
    pubkeyHex: null,
    source: "none",
    inHost,
    deriveEntropyAvailable,
    deriveEntropyError,
    windowHost,
    seedHash,
  }
}
