"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState, useEffect } from "react"
import { useWeb3Store } from "@/lib/web3/store/use-web3-store"
import { isInHost } from "@/lib/host/detect"
import { connectToHost } from "@/lib/host/connection"
import { getHostAccounts, subscribeHostAccounts } from "@/lib/host/accounts"
import { WalletProviderType, WalletProviderStatus } from "@/lib/web3/types/web3"

/**
 * Auto-connects to host wallet when running inside Polkadot Desktop / dot.li.
 * T3rminal has no other connection path — outside a host container the app
 * stays unauthenticated and pages show a quiet "Connecting to host…" hint
 * instead of any wallet UI.
 */
function HostAutoConnect() {
  const { setAccount, setStatus, account } = useWeb3Store()

  useEffect(() => {
    if (!isInHost()) return
    if (account?.provider === WalletProviderType.HostAPI) return

    let unsubscribe = () => {}

    const autoConnect = async () => {
      console.log("[HostAutoConnect] Detected host environment, connecting…")

      const connected = await connectToHost()
      if (!connected) {
        console.log("[HostAutoConnect] Failed to connect to host")
        return
      }

      const accounts = await getHostAccounts()
      if (accounts.length === 0) {
        console.log("[HostAutoConnect] No accounts from host")
        return
      }

      const first = accounts[0]
      console.log("[HostAutoConnect] Connected:", first.name, first.address)

      setAccount({
        name: first.name,
        address: first.address,
        provider: WalletProviderType.HostAPI,
      })
      setStatus(WalletProviderType.HostAPI, WalletProviderStatus.Connected)

      unsubscribe = await subscribeHostAccounts((updated) => {
        if (updated.length > 0) {
          const acc = updated[0]
          setAccount({
            name: acc.name,
            address: acc.address,
            provider: WalletProviderType.HostAPI,
          })
        }
      })
    }

    autoConnect()

    return () => unsubscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}

export function Web3Provider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 60 * 1000, refetchOnWindowFocus: false },
        },
      })
  )

  return (
    <QueryClientProvider client={queryClient}>
      <HostAutoConnect />
      {children}
    </QueryClientProvider>
  )
}
