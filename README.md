# SilentTip

**Tip any Nostr creator with a Bitcoin Silent Payment — no address reuse, no invoice, no DM.**

SilentTip is a signet-only demo that wires two protocols together:

1. A Nostr creator publishes a **silent payments tipping identity** — a signed,
   parameterized-replaceable Nostr event (kind `30078`, `d` tag `silenttip`)
   containing their `tsp1…` BIP-352 address.
2. A sender looks up the creator by `npub`, `nprofile`, or NIP-05 name,
   verifies the binding's schnorr signature, and builds a **BIP-352 silent
   payment** transaction on Bitcoin **signet**.
3. The receiver **scans signet blocks** with their scan key and cryptographically
   verifies which outputs are theirs — the on-chain output is a fresh P2TR key
   that no observer can link to the published address.

A built-in "what the chain sees" panel compares a silent tip against a plain
address-reuse tip sent from the same demo wallet, making the privacy difference
visible to judges in one click.

> **Signet only.** SilentTip never touches mainnet keys, real funds, or paid
> services. All keys are throwaway test keys generated in your browser.

## Try it

```bash
npm install        # use --legacy-peer-deps if npm complains about peer deps
npm run dev        # local dev server
npm test           # vitest: all 28 official BIP-352 vectors + unit tests
npm run lint && npm run typecheck
npm run build      # static bundle in dist/
```

The four tabs walk the demo end to end:

| Tab | Role |
| --- | ---- |
| **Receive** | Generate/restore a scan+spend key pair (BIP-352 derivation paths `m/352'/1'/0'/0/0` and `…/1`), get a `tsp1…` address, and optionally publish the signed binding to public Nostr relays. |
| **Tip** | Resolve a creator's `npub`/NIP-05/`tsp1`, verify the binding, pick a fee rate, and broadcast a real signet transaction — or a "static tip" for comparison. |
| **Scan** | Fetch the last *n* signet blocks from the mempool.space Esplora API and run the full BIP-352 scanning algorithm against every transaction. |
| **Chain view** | Render what a chain analyst would see: silent-tip outputs are fresh unlinked P2TR keys; a static tip visibly clusters with the sender. |

To run the flow for real: generate a sender wallet in the Tip tab, fund it from
a public signet faucet (e.g. signetfaucet.com), then send a tip and scan.

## Demo assets

- `docs/demo.mp4` — ~90 s walkthrough: identity → Nostr publish → npub
  resolution → on-chain inspection → block scan.
- `docs/screenshots/` — stills of each step.
- `docs/evidence.md` — what is verified and what is not (read before judging).
- `docs/devfolio-draft.md` — submission copy draft.

## Architecture

```
src/
  sp/
    keys.ts       identity generation (BIP39 → m/352' paths), tsp1/sp1 codec
    outputs.ts    spec-exact BIP-352 output creation + scanning (K_max, labels,
                  intermediate-infinity sums — see below)
    scan.ts       input pubkey extraction (P2TR incl. NUMS-H skip, P2WPKH,
                  P2SH-P2WPKH, malleated P2PKH, P2PK), outpoint ordering,
                  per-transaction scanning
    send.ts       throwaway P2WPKH wallet, coin selection, PSBT build/sign
    network.ts    signet parameters + mempool.space links
  chain/esplora.ts  typed mempool.space Esplora client (UTXOs, txs, broadcast)
  nostr/binding.ts  kind-30078 binding publish/fetch/verify, NIP-05 resolution
  ui/             four tabs, zero framework — small DOM helpers only
test/
  vectors.test.ts all 28 official bitcoin/bips BIP-352 send+receive vectors
  vectors/…       vendored vector file (pinned in CI)
  binding.test.ts unit tests: codecs, binding sigs, WIF, extraction, ordering
```

### Why a local `outputs.ts` instead of the library's `createOutputs`/`scanOutputs`?

`@silent-pay/core@0.0.6` handles tagged hashes, address codecs, and input-hash
derivation, but its output creation and scanning diverge from the BIP-352
reference in three ways the official vectors expose:

- **K_max** — the spec aborts a send when one scan-key group exceeds 2323
  recipients and stops scanning at `k = K_max`; the library does neither.
- **Intermediate infinity** — the spec permits an intermediate pubkey/privkey
  sum of the point at infinity; only the *final* sum matters. The library
  throws inside `secp256k1` instead.
- **Permuted label ordering** — the vectors accept any valid output set;
  `outputs.ts` implements the reference loop directly so ordering matches.

`outputs.ts` still uses the library's `createInputHash`, `createTaggedHash`,
`serialiseUint32`, and address codec — only the parts that were wrong are
reimplemented, and the suite proves parity against all 28 official vectors.

### The Nostr binding

```jsonc
// kind 30078 (NIP-78 parameterized replaceable), d = "silenttip"
{
  "v": 1,
  "sp": "tsp1qq…",        // BIP-352 silent payment address, signet HRP
  "network": "signet"
}
```

Signed by the creator's `nsec` or a NIP-07 extension. Anyone can fetch the
newest valid event for the pubkey from public relays and verify the schnorr
signature — no trusted directory.

## Security & limitations (honest list)

- **Demo, not a wallet.** Sender keys are generated in-browser, stored in
  `localStorage`, and the UI is a teaching tool. It is not hardened against
  theft, XSS, or browser compromise. Never import real keys.
- **Scanning is heavy by design.** The Scan tab downloads every transaction in
  each block (capped at 40 blocks) — fine for a demo, unusable as a real wallet.
  Real silent-payments wallets use light-client tweaks servers / BIP-158-style
  filters, which didn't exist for signet at hackathon time.
- **A published tipping identity is public.** Labels exist in the code path
  (and pass the vectors) but the UI only exposes the base address.
- **Sender identity leaks via the UTXO set** — the sender's own input script is
  a plain P2WPKH, so chain analysis can see *who* paid, just not *whom*. That
  asymmetry is the point of the chain-view panel.
- Esplora (`mempool.space/signet`) and the public Nostr relays are trusted for
  *liveness*, not *correctness*: every retrieved event is signature-verified,
  and scanning is pure cryptography over raw block data — but a censoring API
  could hide transactions.
- AI assistance: core implementation was drafted by Devin (Cognition) and
  reviewed/validated against the official BIP-352 vectors and the BIP-352
  Python reference implementation.

## Prior art

- [BIP-352](https://github.com/bitcoin/bips/blob/master/bip-0352.mediawiki) —
  Silent Payments.
- [NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md) —
  parameterized replaceable events (kind 30078).
- Nostr PR [nips#2355](https://github.com/nostr-protocol/nips/pull/2355) drafts
  a NIP that derives silent-payment keys **from the Nostr key** itself.
  SilentTip deliberately keeps the SP keys *independent* of `nsec` — the Nostr
  event is a signed pointer, so rotating the Bitcoin identity doesn't require
  rotating the social one, and losing a Nostr key can't burn funds.

## License

MIT — see [LICENSE](LICENSE).
