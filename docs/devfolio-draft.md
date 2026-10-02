# Devfolio draft copy — SilentTip (BOSS Battle, Cypherpunk track)

Copy-paste sections for the Devfolio submission form. Sharon submits; this is
the draft.

---

## Tagline

One static address in your Nostr bio. Tips arrive on-chain at fresh taproot
outputs observers cannot link back to it.

## The problem it solves

Every Bitcoin donation address you post publicly is a privacy leak: anyone can
watch all your incoming payments, sum your income, and cluster it with your
identity. The usual fix — generating a fresh address per payer — doesn't work
for a static profile field, and asking each sender for a fresh address kills
the spontaneous tip jar entirely.

SilentTip lets a Nostr creator publish a single **silent payments** tipping
identity (BIP-352). A sender resolves that identity and constructs a payment
whose on-chain output is a fresh taproot key that only the receiver can
recognize — for every tip, forever, with zero interaction. To a chain
analyst, each tip is an unremarkable one-off output; nothing on-chain links
it to the published tsp1 address or to other tips to it. (The sender's own
inputs, change, amounts and timing remain visible — sender privacy is out
of scope.)

## What it does

- **Receive:** generate a BIP-352 scan/spend keypair (independent of your
  Nostr key), get a `tsp1…` silent-payment address, and bind it to your npub
  with a signed kind-30078 Nostr event.
- **Tip:** paste a creator's npub — SilentTip fetches the binding from relays,
  verifies the signature, and builds a signet transaction paying a fresh
  silent output. Optionally send a *static-address* tip back to your own
  wallet — the reused address is what a chain analyst clusters on.
- **Scan:** the receiver's browser downloads recent signet blocks and runs
  the BIP-352 ECDH scan locally — no server ever learns the address.
- **What the chain sees:** renders the outputs of each tip transaction
  straight from mempool.space's signet API — reused static outputs cluster
  visibly, every silent tip is a fresh unlinked taproot key.

## How it's built

- `bitcoinjs-lib` + `@silent-pay/core` primitives, with a spec-exact
  reimplementation of the BIP-352 output creation and scanning loops
  (`src/sp/outputs.ts`) where the upstream library diverges from the
  reference implementation (K_max, point-at-infinity edge cases).
- Verified against **all 28 official BIP-352 send-and-receive test vectors**
  plus unit tests (116 green in CI).
- Nostr binding via `nostr-tools`: kind 30078, `d` = `silenttip` —
  parameterized-replaceable, so re-publishing rotates the address.
- Esplora (`mempool.space/signet/api`) for chain reads and broadcast.
- Pure static site (Vite + TypeScript) — no server, no custody, every crypto
  step runs in the browser tab.
- `scripts/signet-e2e.ts` exercises the same pipeline headlessly;
  `scripts/regtest-e2e.ts` proves the transaction derivation, signing and
  receiver-scan logic end to end on a local regtest bitcoind — the tx
  builder and scanner are shared, while UTXO discovery, broadcast
  transport and block fetching differ from the signet path. The run is
  recorded in `public/regtest-proof.mp4` and replayed from the committed
  fixture in `test/regtest.test.ts`; a full re-run needs Docker plus the
  gitignored sender state.

## Challenges we ran into

- **The npm package isn't the spec.** `@silent-pay/core` 0.0.6 fails three
  classes of official test vectors: it doesn't enforce K_max (2323), throws
  on legal intermediate point-at-infinity key sums, and mis-handles eligible-
  input filtering. We kept its tagged-hash/codec helpers and reimplemented
  the ECDH/output/scan loops against `bitcoin/bips` `reference.py`.
- **Signet is easy to describe and hard to fund.** Every public faucet was
  login-, CAPTCHA-, or Cloudflare-gated during the build, so we proved the
  transaction derivation, signing and receiver-scan logic on a local
  regtest chain (`scripts/regtest-proof.json` + screencast, honestly
  labeled — a re-run needs Docker plus the gitignored sender state) and
  left the public signet broadcast gated on a human faucet run —
  `docs/evidence.md` states this explicitly rather than papering over it.
- **The replay fixture is intentionally public.** Its disposable receiver
  private keys are committed so judges can reproduce the regtest scan; that
  receiver is a dedicated regtest-only `tsp1` never bound to Nostr or used
  on signet. Separately, two early demo identities are permanently burned
  (one had committed keys, one had its mnemonic in an early video revision)
  — both the Tip tab and `signet-e2e.mjs tip` refuse them, and a fresh
  promoted identity is used for all public demos (`docs/evidence.md` §5b).
- **Scanning is expensive.** A receiver must trial-decrypt every taproot
  output in range; we scoped the demo to recent blocks and made the cost
  visible instead of hiding it.

## What's next

- Compact block filters / BIP-158-style prefiltering to make scanning cheap.
- NIP-46 remote signing so the nsec never touches the browser.
- Label support is implemented; a label-management UI would enable reusable
  "payment codes" per campaign.
- Publish a formal NIP for the `silenttip` d-tag convention (draft PR #2355
  binds SP keys to nsec; SilentTip deliberately keeps them separate so you
  can rotate either).

## Demo / links

- Repo: https://github.com/sharonbasovich/silenttip
- Live demo: https://sharonbasovich.github.io/silenttip/
- Video walkthrough (hosted): https://sharonbasovich.github.io/silenttip/video.html
- Evidence: `docs/evidence.md` — verified claims only
- Judge notes (Cypherpunk self-audit): `docs/judge-notes.md`
- Screenshots: `docs/screenshots/`

## Disclosure

Built with AI assistance (Devin) for BOSS Battle 2026. Signet/test vectors
only — no real funds, no mainnet keys.
