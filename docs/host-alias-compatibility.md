# Host alias compatibility

The accounts migration does not establish compatibility with keys derived by the older alias protocol. Keep cross-device asymmetric encryption behind explicit compatibility review.

The [legacy host implementation](https://github.com/paritytech/host-rust-core/blob/a2b9b91b0f657bafd662a650ac98eb7d97f9f2c0/rust/crates/truapi-server/src/host_logic/alias.rs#L23) hashes UTF-8 `/product/{identifier}/0` for index zero. The [new context implementation](https://github.com/paritytech/host-rust-core/blob/c02e7247fe1a6a221c9c2ff1821f0ffe40addcca/rust/crates/truapi-server/src/runtime/signing_host/ring_vrf.rs#L228) hashes UTF-8 `product/{identifier}/` followed by a 32-byte expanded derivation index. The [selector RFC](https://github.com/paritytech/host-rust-core/blob/af4bc67c61a035eb1eefdc68d496d4f2856983fc/docs/rfcs/0022-account-derivations.md#L110) defines the `Left(0)` expansion. These are different public inputs; matching wallet credentials alone cannot establish matching alias bytes.

The asymmetric helpers currently have no active application callers. Daily reports use the separate manual-passphrase symmetric path. This does not prove that historical cached keys or ciphertext never existed.

## Local safeguard

Before saving a host-derived pair, the helper reads the raw cache bytes. An absent record permits initialization. A matching public/secret pair is retained. Read failures, malformed records, and either differing field fail without writing. Concurrent derived saves are serialized within one tab.

The cache key is product-global, so switching wallet accounts with an existing different key also fails. An explicit key export/migration and account-scoping design is required before changing that behavior. The guard does not recover historical keys, prove remote-ciphertext compatibility, or coordinate other tabs/devices. The deprecated explicit `saveKeypair` API remains an overwrite API outside this derived-key guard. No automatic deletion or migration is performed.

Tests use synthetic key material and mocked byte storage. Real host/ring deployment and historical-data acceptance remain unverified; do not remove the draft gate based on unit tests or a successful build.

## Remaining transport integration gate

The migration still imports the novasama wrapper for chain RPC, local storage,
permissions, Bulletin, and coinage. Those clients cannot safely coexist with the
new client on one injected port: wrapper 0.8.11 assigns `port.onmessage`, and
TruAPI 0.7.0 assigns it again. Whichever initializes last receives the replies.
In test-host 0.12.1, the legacy inbound channel remains live after the MessagePort
handover, but all replies switch to the port. TruAPI may also adopt a legacy
frame before the handover, making the outcome depend on startup order.

The test host is now pinned to 0.12.1, which includes RFC-0022 wire support. Home
checks wait for the merchant catalog rather than its transient connecting
heading. The selected eight browser checks produced six passes and two failures:
terminal account startup and QR waiting state. This is not a clean integration
result. The PR must remain draft until transport ownership is unified or the
remaining wrapper consumers migrate, followed by real-host storage, account,
and payment acceptance. Longer timeouts do not repair response misrouting.
