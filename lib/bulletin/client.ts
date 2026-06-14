/**
 * Bulletin Chain client — host preimage path.
 *
 * Uploads route through `preimageManager.submit(value)` from product-sdk:
 * the host (Polkadot Desktop) signs and submits `TransactionStorage.store`
 * on Paseo Bulletin Next.
 *
 * Why not merchant-signed locally:
 *  We tried building the extrinsic locally, signing with the host's
 *  product-account signer, and submitting via WS-direct. That path fails
 *  on the host with `SigningErr: message too big` — the host's signPayload
 *  slot relays the entire encoded tx to the phone wallet, which caps it
 *  at ~256 bytes. Preimage extrinsics are a few KB.
 *
 * Allowance prerequisite:
 *  The host forwards the preimage submit to the phone wallet, the phone
 *  signs, and the chain validates. The chain rejects with
 *  `StatementStore: no allowance set for account` unless the user's
 *  host-derived account has an active `BulletInAllowance` on-chain.
 *  We grant that lazily via `ensureBootstrap` (lib/host/allowances.ts) —
 *  one host modal per session, memoized.
 *
 * Permission prerequisite:
 *  The host gates the submit slot behind the `PreimageSubmit` remote
 *  permission, granted via `ensurePreimageSubmitPermission`
 *  (lib/host/allowances.ts) before every submit. Distinct from the on-chain
 *  `BulletInAllowance` above; without it the host silently drops the request
 *  and the call hangs forever.
 *
 * Reads go through the same host preimage path. Inside the container we call
 * `preimageManager.lookup(key)` — the host serves the bytes from its own
 * Bulletin node, so no public HTTPS gateway is involved. The lookup key is the
 * CID's Blake2b-256 multihash digest (see `cidToPreimageKey`), which is the
 * exact hash `submit` returned at upload time. Standalone (outside a host, e.g.
 * local dev) has no preimage API, so reads fall back to the multi-gateway race
 * in `lib/bulletin/upload.ts`. The gateway also backstops an in-host lookup
 * that returns null / times out.
 */

"use client"

import { calculateCID, cidToPreimageKey } from "./cid"
import { BULLETIN_ENDPOINTS, readJsonFromGateway } from "./upload"
import { claimDefaultAllowances, ensurePreimageSubmitPermission } from "@/lib/host/allowances"

export interface BulletinUploadResult {
  cid: string
  kind: "preimage"
  gatewayUrl: string
  /** SS58 of the account the host used to submit the preimage. */
  signedBy: string
}

const PREIMAGE_SUBMIT_TIMEOUT_MS = 120_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `${label} timed out after ${ms}ms — the host did not respond. Ensure the ` +
                `PreimageSubmit permission was granted in the Polkadot app and retry.`,
            ),
          ),
        ms,
      ),
    ),
  ])
}

export async function uploadToBulletinChain(
  data: Uint8Array,
): Promise<BulletinUploadResult> {
  const { isInHost } = await import("@/lib/host/detect")
  if (!isInHost()) {
    throw new Error(
      "Bulletin upload requires a host environment (Polkadot Desktop). " +
      "Open T3rminal inside the desktop product container so the host can " +
      "submit preimages on Paseo Bulletin on your behalf.",
    )
  }

  // Claim on-chain BulletInAllowance (idempotent — cached per session). Host
  // forwards the resulting modal to the phone wallet; once granted, repeated
  // calls within the page lifetime short-circuit.
  await claimDefaultAllowances()

  // Must precede submit: the host silently drops un-permitted submits (hangs).
  await ensurePreimageSubmitPermission()

  const cid = calculateCID(data)
  const gatewayUrl = `${BULLETIN_ENDPOINTS.paseo.gateway}${cid}`

  const { preimageManager } = await import("@novasamatech/host-api-wrapper")
  console.log("[Bulletin] Submitting preimage via host API, size:", data.length)
  let key: string
  try {
    key = await withTimeout(preimageManager.submit(data), PREIMAGE_SUBMIT_TIMEOUT_MS, "host preimage submit")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/no allowance set for account/i.test(message)) {
      throw new Error(
        "Paseo Bulletin rejected the preimage submission (`no allowance " +
        "set for account`). The host-side allowance modal completed but " +
        "the on-chain grant didn't land — open Polkadot Mobile, approve " +
        "the pending Bulletin allowance request, and retry. If no request " +
        "is pending, your phone wallet may have signed before the grant " +
        "extrinsic landed; wait one block and try again.",
      )
    }
    throw err
  }
  console.log("[Bulletin] Preimage stored, host key:", key)

  return {
    cid,
    kind: "preimage",
    gatewayUrl,
    signedBy: "host:product-account",
  }
}

/**
 * Resolve a preimage by key through the host API, wrapping the callback-style
 * `lookup` subscription into a promise. Resolves `null` if the host produces no
 * preimage within `timeoutMs` (caller falls back to the gateway).
 */
async function lookupPreimage(
  key: `0x${string}`,
  timeoutMs = 15000,
): Promise<Uint8Array | null> {
  const { preimageManager } = await import("@novasamatech/host-api-wrapper")
  return new Promise<Uint8Array | null>((resolve) => {
    let done = false
    const finish = (value: Uint8Array | null) => {
      if (done) return
      done = true
      subscription.unsubscribe()
      resolve(value)
    }
    const subscription = preimageManager.lookup(key, (preimage) => finish(preimage))
    setTimeout(() => finish(null), timeoutMs)
  })
}

/**
 * Fetch JSON stored on Bulletin for a CID.
 *
 * In-host: resolve via `preimageManager.lookup` (the host serves preimages it
 * submitted itself). The host store can't serve a report uploaded on another
 * device/session, or one that hasn't propagated yet — in those cases (and
 * standalone) we fall back to the DEDICATED Parity gateway only. We never race
 * third-party web2 gateways, so the CID never leaks off the Polkadot trust
 * domain.
 */
export async function fetchJsonFromBulletin<T = unknown>(cid: string): Promise<T> {
  const { isInHost } = await import("@/lib/host/detect")

  if (isInHost()) {
    const key = cidToPreimageKey(cid)
    console.log("[Bulletin] Looking up preimage via host API, key:", key)
    try {
      const bytes = await lookupPreimage(key)
      if (bytes) {
        return JSON.parse(new TextDecoder().decode(bytes)) as T
      }
      console.warn(
        "[Bulletin] Host preimage lookup empty; falling back to the dedicated Bulletin gateway",
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(
        "[Bulletin] Host preimage lookup failed; falling back to the dedicated Bulletin gateway:",
        message,
      )
    }
  }

  console.log("[Bulletin] Fetching from dedicated Bulletin gateway, CID:", cid)
  return readJsonFromGateway<T>(cid)
}

/**
 * Public IPFS gateway URL for a CID — used for share / "Open in IPFS" links.
 */
export function gatewayUrlForCid(cid: string): string {
  return `${BULLETIN_ENDPOINTS.paseo.gateway}${cid}`
}
