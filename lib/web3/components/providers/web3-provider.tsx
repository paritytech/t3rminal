"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState, useEffect } from "react"
import { useWeb3Store } from "@/lib/web3/store/use-web3-store"
import { isInHost } from "@/lib/host/detect"
import { connectToHost } from "@/lib/host/connection"
import { subscribeHostAccounts } from "@/lib/host/accounts"
import { WalletProviderType, WalletProviderStatus } from "@/lib/web3/types/web3"

/**
 * Auto-connects to host wallet when running inside Polkadot Desktop / dot.li.
 * T3rminal has no other connection path — outside a host container the app
 * stays unauthenticated and pages show a quiet "Connecting to host…" hint
 * instead of any wallet UI.
 */
function HostAutoConnect() {
  const { setAccount, setStatus } = useWeb3Store()

  useEffect(() => {
    if (!isInHost()) return
    let disposed = false
    let unsubscribe = () => {}

    const clearAccount = () => {
      if (disposed) return
      setAccount(null)
      setStatus(WalletProviderType.HostAPI, WalletProviderStatus.Disconnected)
    }
    const autoConnect = async () => {
      try {
        const connected = await connectToHost()
        if (disposed) return
        if (!connected) {
          clearAccount()
          return
        }
        const stop = await subscribeHostAccounts((accounts) => {
          if (disposed) return
          const first = accounts[0]
          if (!first) {
            clearAccount()
            return
          }
          setAccount({ name: first.name, address: first.address, provider: WalletProviderType.HostAPI })
          setStatus(WalletProviderType.HostAPI, WalletProviderStatus.Connected)
        }, () => clearAccount())
        if (disposed) stop()
        else unsubscribe = stop
      } catch {
        clearAccount()
        if (!disposed) console.warn("[HostAutoConnect] Account connection failed")
      }
    }

    void autoConnect()
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [setAccount, setStatus])

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
