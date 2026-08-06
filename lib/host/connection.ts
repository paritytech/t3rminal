/**
 * Host API connection
 *
 * Uses getAccountsProvider from @parity/product-sdk/host to connect to
 * accounts. Works on both Desktop (webview) and dot.li (iframe).
 */

import {
  getAccountsProvider as getHostAccountsProvider,
  type AccountsProvider,
} from "@parity/product-sdk/host"
import { isInHost } from "./detect"

let accountsProvider: AccountsProvider | null = null
let connected = false

export async function getAccountsProvider(): Promise<AccountsProvider | null> {
  if (!accountsProvider) {
    accountsProvider = await getHostAccountsProvider()
  }
  return accountsProvider
}

export async function connectToHost(): Promise<boolean> {
  if (!isInHost()) return false
  if (connected) return true

  try {
    const provider = await getAccountsProvider()
    if (!provider) return false
    connected = true
    console.log("[Host] Transport ready")
    return true
  } catch (e: any) {
    console.log(`[Host] Connection error: ${e?.message || e}`)
    return false
  }
}

export function isHostConnected(): boolean {
  return connected
}
