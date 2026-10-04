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
   that does not publish the recipient's reusable address in the output.
   This reduces recipient-address reuse linkage; it does not hide the sender
   or guarantee that payment relationships cannot be inferred.

A built-in "what the chain sees" panel can inspect signet output scripts.
The recorded UI walkthrough inspects an unrelated signet transaction; it is
not evidence of a SilentTip payment or a completed side-by-side comparison.
The separate local-regtest recording demonstrates a completed silent payment.

> **Signet UI plus separate local-regtest proof.** The hosted UI targets
> signet; the completed transaction proof uses a disposable local regtest
> chain. No mainnet keys or funds are used. Never import real keys.

**Live demo:** https://sharonbasovich.github.io/silenttip/ ·
**Demo video:** https://sharonbasovich.github.io/silenttip/video.html

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
| **Chain view** | Render what a chain analyst would see: silent-tip outputs use fresh P2TR keys rather than the recipient's reusable address; static-address reuse creates a direct linkage. |

No funded public signet tip has been verified. The recorded UI walkthrough is
unfunded; the completed transaction proof is on local regtest. That proof
uses the same transaction builder and scanner, but different UTXO discovery,
broadcast transport and block retrieval. It does not establish public signet
readiness after funding. See `docs/evidence.md` §4–4b.

## Demo assets

- [`video.html`](video.html) + [`public/demo.mp4`](public/demo.mp4) —
  judge-readable video page (deployed at `/silenttip/video.html`) embedding the
  narrated walkthrough: creator tip-jar problem → genuine public binding
  resolution → complete earlier local-regtest proof → precise privacy limits.
  The new UI capture uses an isolated empty context and only the published
  demo identity; no private keys are created or entered.
- [`public/regtest-proof.mp4`](public/regtest-proof.mp4) +
  [`scripts/regtest-proof.json`](scripts/regtest-proof.json) — screencast
  and fixture (incl. raw tx hex) of the full send → broadcast → receiver-scan
  run on a local regtest bitcoind ([`scripts/regtest-e2e.ts`](scripts/regtest-e2e.ts);
  disposable keys/coins only, dedicated regtest-only receiver, honestly labeled
  regtest — no funded public signet tip has been verified).
- [`scripts/signet-e2e.ts`](scripts/signet-e2e.ts) also guards funded runs:
  `tip` refuses any tsp1 on the burned list
  ([`src/sp/burned.ts`](src/sp/burned.ts)), and `rotate` / `rotate-receiver`
  generate fresh private receivers before a future funded signet demo.
- [`docs/screenshots/`](docs/screenshots) — stills of each step.
- [`docs/evidence.md`](docs/evidence.md) — what is verified and what is not
  (read before judging).
- [`docs/judge-notes.md`](docs/judge-notes.md) — Cypherpunk-track self-audit
  of the hook/story.
- [`docs/devfolio-draft.md`](docs/devfolio-draft.md) — submission copy draft.

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
- **Recipient-address reuse protection.** Payment relationships may still be
  inferred. Sender
  inputs, change, amounts and timing remain visible. These may support
  inference about participants; co-spending received tips can link outputs.
  A visible input script is not by itself proof of a person's identity.
- Esplora (`mempool.space/signet`) and the public Nostr relays are trusted for
  *liveness*, not *correctness*: every retrieved event is signature-verified,
  and scanning is pure cryptography over raw block data — but a censoring API
  could hide transactions.
- **Rotated demo identities are burned.** Two early demo tsp1 addresses had
  private material exposed (committed fixture keys; a mnemonic in an early
  video revision). Both are in `src/sp/burned.ts` — the Tip tab refuses to
  tip them — and details/rotation are in
  [`docs/evidence.md`](docs/evidence.md) §5b.
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
