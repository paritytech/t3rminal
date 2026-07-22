"use client";

/**
 * BulletinIndex contract interaction via direct ReviveApi.call
 *
 * Uses ethers.js for ABI encoding/decoding and polkadot-api's
 * ReviveApi runtime API for read-only calls. This approach works
 * reliably with Solidity contracts on Revive pallet.
 */

import { ethers } from "ethers";
import { Binary } from "polkadot-api";
import { T3rminalBulletinIndexABI } from "./abis";
import { getContractAddresses } from "./config";
import { getAPI } from "./chain";
import { claimDefaultAllowances } from "@/lib/host/allowances";
import { loadAdminQrPayload } from "@/lib/config/admin-qr";
import type { PolkadotSigner } from "polkadot-api";

// ABI interface for encoding/decoding calldata (no network calls)
const iface = new ethers.Interface(T3rminalBulletinIndexABI);

// Alice on Paseo — known mapped account for read-only Revive calls.
// ReviveApi.call requires a mapped origin even for pure view functions.
const READ_ORIGIN = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

/**
 * Execute a read-only contract call via ReviveApi.call runtime API.
 * Uses Alice as origin — she's always mapped and view functions
 * don't depend on caller identity.
 */
async function readContract(
  functionName: string,
  args: unknown[]
): Promise<ethers.Result> {
  const { bulletinIndex } = getContractAddresses();
  const calldata = iface.encodeFunctionData(functionName, args);
  const client = await getAPI();

  const result = await client.assetHub.apis.ReviveApi.call(
    READ_ORIGIN,
    bulletinIndex as `0x${string}`,
    BigInt(0),
    undefined, // gas_limit
    undefined, // storage_deposit_limit
    Binary.fromHex(calldata as `0x${string}`)
  );

  if (result.result.success) {
    const hex = Binary.toHex(result.result.value.data);
    // Empty output (`0x`) from a *successful* call means there is no contract
    // code at `bulletinIndex` on the chain we're connected to — calling a
    // codeless account succeeds with no return data (same as a bare EOA call).
    // A genuine empty result (e.g. an empty `string[]`) is never `0x`; it's at
    // least the 64-byte ABI head. Handing `0x` to ethers throws the cryptic
    // `could not decode result data (value="0x" … code=BAD_DATA)` the operator
    // saw, so we translate it into an actionable message instead.
    if (hex === "0x" || hex === "0x0") {
      throw new Error(
        `No T3rminalBulletinIndex contract found at ${bulletinIndex} on this ` +
          `chain. The app was likely built/published without the deployed ` +
          `contract address (NEXT_PUBLIC_BULLETIN_INDEX_ADDRESS), or points at ` +
          `a different/reset network. Rebuild and republish via "npm run deploy".`,
      );
    }
    return iface.decodeFunctionResult(functionName, hex);
  } else {
    throw new Error(`Contract call ${functionName} failed: ${JSON.stringify(result.result.value)}`);
  }
}

// ========== TYPES ==========

export interface OnChainDayMetadata {
  cid: string;
  entryCount: number;
  publishedAt: number;
  terminalId: string;
  finalized: boolean;
  exists: boolean;
}

/** The (merchantId, terminalId) identity that scopes on-chain report slots. */
export interface MerchantTerminal {
  merchantId: string;
  terminalId: string;
}

/**
 * Resolve the active (merchantId, terminalId) from the scanned admin QR config.
 * These scope every on-chain report slot, replacing the old URL-derived
 * shopKey. Throws if the terminal has not been bound to a merchant yet.
 */
export async function getMerchantTerminal(): Promise<MerchantTerminal> {
  const payload = await loadAdminQrPayload();
  if (!payload?.merchantId || !payload?.terminalId) {
    throw new Error(
      "No merchant/terminal config — scan an admin QR before saving reports.",
    );
  }
  return { merchantId: payload.merchantId, terminalId: payload.terminalId };
}

// ========== WRITE FUNCTIONS ==========

/**
 * Phase callback for surfacing on-chain progress to UI.
 */
export type OnChainPhase = "submitting-onchain";

/** Default timeout for host-bridge reads. The mobile host's bridge reads can
 *  hang indefinitely (no `chainHead` state delivered), so every read on the
 *  Asset Hub client is raced against this so the flow can't stall before the
 *  signature step. */
const READ_TIMEOUT_MS = 8000;

// ── Mapped-account cache ─────────────────────────────────────────────────────
// Revive.map_account is once-per-account, but we paid the probe (2 host-bridge
// reads, up to 8s timeout each) on EVERY report. Cache the mapped fact in
// localStorage, keyed by contract address so a chain reset / redeploy (which
// changes the address) naturally invalidates it. If the cache goes stale some
// other way, the Revive.call fails with `AccountUnmapped` — the submit path
// below catches exactly that, clears the cache, maps, and retries once.

function mappedCacheKey(origin: string): string {
  return `t3rminal.revive.mapped:${getContractAddresses().bulletinIndex}:${origin}`;
}

/** localStorage can throw (private mode, disabled storage) — never let the
 *  cache break the flow; a failed read just means "probe as before". */
function readMappedCache(origin: string): boolean {
  try {
    return localStorage.getItem(mappedCacheKey(origin)) === "1";
  } catch {
    return false;
  }
}

function writeMappedCache(origin: string): void {
  try {
    localStorage.setItem(mappedCacheKey(origin), "1");
  } catch {
    /* non-fatal — next run probes again */
  }
}

function clearMappedCache(origin: string): void {
  try {
    localStorage.removeItem(mappedCacheKey(origin));
  } catch {
    /* non-fatal */
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`[BulletinIndex] ${what} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * Store a daily report CID via Revive.call extrinsic.
 *
 * The slot is scoped by (merchantId, terminalId, date). When `finalize` is
 * true the contract locks the slot — any later write to the same slot reverts.
 *
 * @param onPhase optional callback fired when entering each on-chain phase,
 *   so the UI can show what's currently being awaited (signature prompt, etc.)
 */
export async function storeDailyReportViaRevive(
  origin: string,
  signer: PolkadotSigner,
  params: {
    merchantId: string;
    terminalId: string;
    date: string;
    cid: string;
    entryCount: number;
    finalize: boolean;
  },
  onPhase?: (phase: OnChainPhase) => void
): Promise<string> {
  const { bulletinIndex } = getContractAddresses();
  const calldata = iface.encodeFunctionData("storeDailyReport", [
    params.merchantId,
    params.terminalId,
    params.date,
    params.cid,
    params.entryCount,
    params.finalize,
  ]);

  console.log(
    `[BulletinIndex] storeDailyReport from ${origin.slice(0, 10)}… → contract: ${bulletinIndex}, merchant: ${params.merchantId}, terminal: ${params.terminalId}, date: ${params.date}, cid: ${params.cid}, entries: ${params.entryCount}, finalize: ${params.finalize}`
  );
  console.log(`[BulletinIndex] calldata (${calldata.length / 2 - 1} bytes): ${calldata.slice(0, 80)}...`);

  // Claim on-chain resource allowances. `SmartContractAllowance(0)` is the
  // critical one — without it the chain's `AsPgas` signed-extension rejects
  // every signed Revive.call with `BadProof`. Idempotent + cached per session.
  await claimDefaultAllowances();

  const client = await getAPI();
  // Warm the client, but don't let a non-responsive host-bridge read hang the
  // flow before we ever reach the signature step (seen on the mobile host).
  await withTimeout(
    client.raw.assetHub.getBestBlocks(),
    READ_TIMEOUT_MS,
    "getBestBlocks",
  ).catch((e) => console.warn("[BulletinIndex] getBestBlocks warmup timed out, continuing:", e));

  // Untyped tx surface — matches Tommy's writeContract on the main branch.
  const unsafeApi = client.raw.assetHub.getUnsafeApi();
  type WatchableTx = {
    decodedCall: unknown;
    signSubmitAndWatch(signer: PolkadotSigner, opts?: unknown): {
      subscribe(observer: { next(ev: unknown): void; error(e: unknown): void }): { unsubscribe(): void };
    };
  };
  type ReviveTxShim = {
    call(args: {
      dest: string;
      value: bigint;
      weight_limit: { ref_time: bigint; proof_size: bigint };
      storage_deposit_limit: bigint;
      data: Uint8Array;
    }): WatchableTx;
    map_account(): WatchableTx;
  };
  const reviveTx = unsafeApi.tx.Revive as unknown as ReviveTxShim;

  // Probe mapping status via ReviveApi.address(ss58) → query.Revive.OriginalAccount[h160].
  // Each read is timeout-guarded: the mobile host bridge can leave these reads
  // pending forever, which previously hung the whole flow here — before the
  // signature step was ever reached, so no prompt appeared on the phone.
  const isAccountMapped = async (): Promise<boolean> => {
    const reviveApi = (unsafeApi.apis as unknown as {
      ReviveApi?: { address(ss58: string): Promise<string | null> };
    }).ReviveApi;
    const addr = reviveApi?.address(origin);
    const h160 = addr ? await withTimeout(addr, READ_TIMEOUT_MS, "ReviveApi.address") : null;
    if (!h160) return false;
    const q = (unsafeApi.query as unknown as {
      Revive?: { OriginalAccount?: { getValue(h: string): Promise<unknown> } };
    }).Revive?.OriginalAccount?.getValue(h160);
    const original = q ? await withTimeout(q, READ_TIMEOUT_MS, "Revive.OriginalAccount") : null;
    return original != null;
  };

  const submitOpts = { mortality: { mortal: true as const, period: 256 } };

  // Runs Revive.map_account, tolerating the already-mapped race. Idempotent.
  const mapAccount = async (): Promise<void> => {
    onPhase?.("submitting-onchain");
    console.log("[BulletinIndex] → Revive.map_account (awaiting signature on phone)…");
    try {
      // Same protection as Revive.call below: an inclusion oracle that resolves
      // once the account shows mapped in state, for hosts whose follow never
      // delivers tx-state events. If the account was already mapped, the oracle
      // confirms on its first poll instead of waiting out the stall watchdog.
      await watchTx(reviveTx.map_account(), signer, submitOpts, isAccountMapped, "map_account");
      console.log("[BulletinIndex] ✓ map_account confirmed");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!/AccountAlreadyMapped/i.test(message)) throw e;
      console.log("[BulletinIndex] map_account: already mapped on-chain (race), continuing");
    }
  };

  // Skip the probe (2 host-bridge reads, up to 8s each) when a previous run on
  // this contract already confirmed the mapping. Staleness is handled by the
  // AccountUnmapped retry around the Revive.call submit below.
  if (readMappedCache(origin)) {
    console.log("[BulletinIndex] account mapped (cached) — skipping probe");
  } else {
    let isMapped = false;
    try {
      isMapped = await isAccountMapped();
      console.log(`[BulletinIndex] account mapped on-chain: ${isMapped}`);
    } catch (err) {
      // Read timed out / threw — don't abort. Fall through to map_account, which
      // is idempotent (AccountAlreadyMapped is caught) and whose inclusion oracle
      // confirms quickly if the account was in fact already mapped.
      console.warn("[BulletinIndex] mapping probe failed/timed out — will attempt map_account:", err);
    }

    if (!isMapped) await mapAccount();
    writeMappedCache(origin);
  }

  onPhase?.("submitting-onchain");
  console.log(`[BulletinIndex] → Revive.call → ${bulletinIndex} (awaiting signature on phone)…`);

  // Oracle: poll `getCID(merchantId, terminalId, date)` to detect inclusion via
  // state read. Workaround for chains whose host-bridge `chainHead_v1_follow`
  // never delivers `txBestBlocksState` to PAPI's `signSubmitAndWatch` — the tx
  // lands on-chain but the watcher hangs forever otherwise. Once our CID
  // appears in storage, the tx is in a block and we can resolve.
  const expectedCid = params.cid;
  const inclusionOracle = async (): Promise<boolean> => {
    try {
      const decoded = await readContract("getCID", [
        params.merchantId,
        params.terminalId,
        params.date,
      ]);
      const onChainCid = decoded[0] as string;
      return onChainCid === expectedCid;
    } catch {
      return false;
    }
  };

  const submitReviveCall = () =>
    watchTx(
      reviveTx.call({
        dest: bulletinIndex,
        value: BigInt(0),
        weight_limit: { ref_time: BigInt("50000000000"), proof_size: BigInt("1000000") },
        storage_deposit_limit: BigInt("10000000000"),
        data: Binary.fromHex(calldata as `0x${string}`) as unknown as Uint8Array,
      }),
      signer,
      submitOpts,
      inclusionOracle,
      "Revive.call",
    );

  let blockHash: `0x${string}`;
  try {
    blockHash = await submitReviveCall();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Stale mapped-cache (chain reset the cache key survived, or a mapping
    // probe that raced a reset): the dispatch error surfaces as
    // `AccountUnmapped`. Recover in place — drop the cache, map, retry ONCE.
    // Anything else (including a stall, which is ambiguous) propagates.
    if (!/AccountUnmapped/i.test(message)) throw e;
    console.warn("[BulletinIndex] Revive.call rejected with AccountUnmapped — re-mapping and retrying once");
    clearMappedCache(origin);
    await mapAccount();
    writeMappedCache(origin);
    blockHash = await submitReviveCall();
  }

  console.log(`[BulletinIndex] ✓ Revive.call confirmed (block ${blockHash.slice(0, 12)}…)`);
  return blockHash;
}

/**
 * `signSubmitAndWatch` with a dual resolution path:
 *   - PAPI `txBestBlocksState.found` fires → resolve (happy path).
 *   - Oracle returns true → resolve (workaround for chains where chainHead
 *     follow doesn't deliver state events to the host bridge).
 *
 * 120s stall watchdog rejects if NEITHER path settles.
 */
function watchTx(
  tx: {
    signSubmitAndWatch(signer: PolkadotSigner, opts?: unknown): {
      subscribe(observer: { next(ev: unknown): void; error(e: unknown): void }): { unsubscribe(): void };
    };
  },
  signer: PolkadotSigner,
  submitOpts: unknown,
  inclusionOracle: (() => Promise<boolean>) | undefined,
  label: string,
): Promise<`0x${string}`> {
  const POLL_INTERVAL_MS = 1500;
  const STALL_TIMEOUT_MS = 120_000;

  return new Promise<`0x${string}`>((resolve, reject) => {
    let settled = false;
    let pollLoopStopped = false;
    let broadcastedHash: `0x${string}` | undefined;
    let signedHash: `0x${string}` | undefined;
    let watchdogStarted = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;

    const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = undefined; } };
    const armStall = () => {
      clearStall();
      stallTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        pollLoopStopped = true;
        try { sub.unsubscribe(); } catch { /* noop */ }
        reject(new Error(`[${label}] stalled: no inclusion within ${STALL_TIMEOUT_MS}ms of broadcast`));
      }, STALL_TIMEOUT_MS);
    };

    const succeed = (hash: `0x${string}`) => {
      if (settled) return;
      settled = true;
      pollLoopStopped = true;
      clearStall();
      resolve(hash);
    };

    // Arm the stall watchdog and start the inclusion-oracle poll. Called on the
    // FIRST of `signed` / `broadcasted` — some host bridges never deliver the
    // `broadcasted` event even though the tx goes out, and previously that
    // meant no watchdog and no oracle: the flow hung until the outer report
    // timeout. Starting at `signed` costs at most one early (false) oracle
    // poll and removes that hang mode. Idempotent.
    const startWatchdog = () => {
      if (watchdogStarted || settled) return;
      watchdogStarted = true;
      console.log(`[${label}] arming inclusion watchdog (${STALL_TIMEOUT_MS}ms)`);
      armStall();
      if (inclusionOracle) {
        void (async () => {
          await Promise.resolve();
          while (!pollLoopStopped && !settled) {
            try {
              const landed = await inclusionOracle();
              if (landed) {
                console.log(`[${label}] inclusion oracle: landed (state read confirms tx effect)`);
                // Prefer the broadcast hash; fall back to the signed hash so a
                // missing `broadcasted` event can't leave the promise pending.
                succeed((broadcastedHash ?? signedHash ?? "0x") as `0x${string}`);
                return;
              }
              armStall();
            } catch (err) {
              console.warn(`[${label}] inclusion oracle threw:`, err);
            }
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          }
        })();
      }
    };

    const sub = tx.signSubmitAndWatch(signer, submitOpts).subscribe({
      next(ev: unknown) {
        const e = ev as { type?: string; found?: boolean; ok?: boolean; dispatchError?: unknown; txHash?: string; block?: { hash: string; number: number } };
        if (e.type === "signed") {
          signedHash = e.txHash as `0x${string}` | undefined;
          console.log(`[${label}] signed (txHash=${e.txHash?.slice(0, 12)}…)`);
          startWatchdog();
        }
        if (e.type === "broadcasted") {
          broadcastedHash = e.txHash as `0x${string}` | undefined;
          console.log(`[${label}] broadcasted`);
          startWatchdog();
        }
        if (e.type === "txBestBlocksState" && e.found) {
          armStall();
          if (e.ok === false) {
            if (settled) return;
            settled = true;
            pollLoopStopped = true;
            clearStall();
            try { sub.unsubscribe(); } catch { /* noop */ }
            reject(new Error(`[${label}] dispatch error: ${JSON.stringify(e.dispatchError)}`));
            return;
          }
          console.log(`[${label}] txBestBlocksState.found in block ${e.block?.hash?.slice(0, 12)}…`);
          succeed((e.block?.hash ?? broadcastedHash ?? signedHash ?? "0x") as `0x${string}`);
        }
        if (e.type === "finalized") {
          console.log(`[${label}] finalized (block ${e.block?.hash?.slice(0, 12)}…)`);
          if (!settled) succeed((e.block?.hash ?? broadcastedHash ?? signedHash ?? "0x") as `0x${string}`);
          try { sub.unsubscribe(); } catch { /* noop */ }
        }
      },
      error(err: unknown) {
        if (settled) return;
        settled = true;
        pollLoopStopped = true;
        clearStall();
        console.error(`[${label}] subscription error:`, err);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    });
  });
}

// ========== READ FUNCTIONS ==========

/**
 * Get all report dates for a terminal under a merchant.
 */
export async function getAllDatesViaRevive(
  merchantId: string,
  terminalId: string
): Promise<string[]> {
  const decoded = await readContract("getAllDates", [merchantId, terminalId]);
  return decoded[0] as string[];
}

/**
 * Get report count for a terminal under a merchant.
 */
export async function getReportCountViaRevive(
  merchantId: string,
  terminalId: string
): Promise<number> {
  const decoded = await readContract("getReportCount", [merchantId, terminalId]);
  return Number(decoded[0]);
}

/**
 * Get metadata for a specific terminal + date.
 */
export async function getMetadataViaRevive(
  merchantId: string,
  terminalId: string,
  date: string
): Promise<OnChainDayMetadata> {
  const decoded = await readContract("getMetadata", [merchantId, terminalId, date]);
  const meta = decoded[0];
  return {
    cid: meta.cid,
    entryCount: Number(meta.entryCount),
    publishedAt: Number(meta.publishedAt),
    terminalId: meta.terminalId,
    finalized: meta.finalized,
    exists: meta.exists,
  };
}

/**
 * Get CID for a specific terminal + date.
 */
export async function getCIDViaRevive(
  merchantId: string,
  terminalId: string,
  date: string
): Promise<string> {
  const decoded = await readContract("getCID", [merchantId, terminalId, date]);
  return decoded[0] as string;
}

/**
 * Check whether a terminal + date slot is finalized (locked) on-chain.
 */
export async function isFinalizedViaRevive(
  merchantId: string,
  terminalId: string,
  date: string
): Promise<boolean> {
  const decoded = await readContract("isFinalized", [merchantId, terminalId, date]);
  return decoded[0] as boolean;
}

/**
 * Get all terminalIds ever seen under a merchant. Lets an admin app that knows
 * only the merchantId enumerate every terminal.
 */
export async function getTerminalsViaRevive(merchantId: string): Promise<string[]> {
  const decoded = await readContract("getTerminals", [merchantId]);
  return decoded[0] as string[];
}
