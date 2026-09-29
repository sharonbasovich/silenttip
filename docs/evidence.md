# Evidence — what is verified and how

Everything below was executed and observed. Nothing is simulated, mocked, or claimed beyond what ran.

## 1. BIP-352 correctness — official test vectors

All 28 official send-and-receive test vectors from `bitcoin/bips` (BIP-352)
pass against the implementation in `src/sp/outputs.ts` + `src/sp/scan.ts`:

```
npm test          # 69 tests, all green
```

`test/vectors.test.ts` consumes the vendored vector file
(`test/vectors/send_and_receive_test_vectors.json`) including the edge cases
the upstream `@silent-pay/core` 0.0.6 npm release gets wrong:

- K_max = 2323 outputs per scan-key group (case 27, `count: 2324`)
- intermediate point-at-infinity key sums are legal; only the final sum must
  be non-infinity (case 26)
- `expected.outputs` is a list of valid permutations — matched as sets
- NUMS-H taproot inputs are excluded from the input-pubkey sum (cases 19, 21, 22, 24)
- label scanning (both output parities) per the BIP-352 reference implementation

Run locally:

```
git clone https://github.com/sharonbasovich/silenttip
cd silenttip && npm ci --legacy-peer-deps
npm test
```

## 1b. Hosted demo — verified end to end

The app is deployed on GitHub Pages and was exercised live:

- **URL:** https://sharonbasovich.github.io/silenttip/ (deployed by
  `.github/workflows/pages.yml`, run 36377757882)
- On the deployed site: generated a BIP-352 identity, published a binding,
  resolved the resulting npub (signature verified), ran a 1-block scan via
  Esplora, and inspected a real signet transaction — zero console errors.
- **Binding events published from the hosted site (now BURNED — see §5b):**
  `3a6e4460e1dfea21…`, `252f504ff529dd5d…` and `4b7c717b8e55b832…`
  (kind 30078, `d`=`silenttip`), accepted by the public relays; they bound
  `tsp1qq0nekn7ye8ckm9d7unfl9c8w5vqcaup0m2quphwa8r6kfs3c6xs76quvrz2zt43zcmqtgyas9zzjm40800nhkddv88n0drz636awdxvv0yprxu3l`.
  That identity's mnemonic briefly appeared in an early revision of
  `public/demo.mp4` — it is permanently compromised; do not tip it.

## 2. Nostr binding — a real, verifiable event on public relays

Kind-30078 (NIP-78 parameterized replaceable) events with `d` tag
`silenttip` were signed and published to public relays:

**Current promoted demo creator** (generated off-camera on 2026-09-28; its
keys live only in gitignored local state — no private material is committed):

- **Event id:** `5a9f1252c63454c7a1b4c604562a725060b0bb0434436d4e16bff9f67c2064f6`
- **Author:** `npub1ds2lqjnc0u4zghaplaa306t0nz36l3fmzngnvztq5m5d4y9ruxtqy5ejdp`
- **Content:** `{"v":1,"sp":"tsp1qq2fp8ruh26d3zwqm9ej6u970sw63cg7jz6g5c4ejek85u6sk9nlkyqesam0wxj0x9wpmvwaf7qvhvk3vkzclyuyjdy7p0wplls4x09lz0se02ypg","network":"signet"}`
- **Accepted by:** `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net` (3/3)

**Earlier bindings — BURNED** (signatures valid, but the bound tsp1 identities'
private material became public — see §5b; do not tip them):

- `cb29c2ee12baf50a84c301aed11c40ec5762f517bfed56d5512f2ef2ba4ee1b0` by
  `npub1uwc89e8w7gx98hxplr6xmdynnz8vtxl78ltuweks2y8vstws0mtsrt3g3q` →
  `tsp1qqfjjuye…` (its scan/spend keys were committed in an early
  `regtest-proof.json` revision; public git history).
- `67bc0957ec3ad835…` by `npub1uu8ffnzr9v97ut3u2spalz499k8vve4hrlxhtpwfmegujzjwplfqj6c8d8` → same burned `tsp1qqfjjuye…`.
- `3a6e4460…`, `252f504f…`, `4b7c717b…` → burned `tsp1qq0nekn7…` (§1b).

Verify any of them yourself:

```
nak req -k 30078 -d silenttip wss://relay.damus.io
```

The **Tip** tab resolves an npub by fetching the newest *signature-valid*
event from relays and verifying the schnorr signature over the tsp1 binding
in-browser. Screenshot: `docs/screenshots/tip-resolve-verified.jpg`.

## 3. On-chain inspection — real signet data

"What the chain sees" fetches transactions from `mempool.space/signet/api`
and renders their output scripts. Any signet txid can be inspected; the demo
uses `1ce23d5182f645431126379781cafb73a61bcad6e2188883ec526c0fc51030f9`
(a real signet transaction). Screenshot: `docs/screenshots/chain-inspect.jpg`.

## 4. Live silent-payment tip — NOT YET EXECUTED

A broadcast signet transaction is only claimed when it exists on-chain.
As of this writing the throwaway sender wallet
(`tb1qreve5pu58jj7y8gej3akgfsse2vnfw6xhf6q2j`) is unfunded.

Every reputable public signet faucet was tried and is gated (latest pass
2026-09-28):

- `bitcoinsignetfaucet.com` — funded and broadcasting, but its Cloudflare
  Turnstile rejects the automated VM browser ("Verification failed", 3 tries).
- `signet.2nd.dev` — on-chain payouts exist (`/api/v1/faucet/pay`) but now
  require GitHub OAuth sign-in; no account creation permitted.
- `signetfaucet.com` — Pterodactyl login panel.
- `mempool.space/signet` — no public faucet-claim API.
- `faucet.bitcoincoding.dev` — connection timeout from this network.
- `arkfaucet.com` — its `/agents/` API documents an `onchain` rail for
  default-signet tb1q addresses. On 2026-09-28 one claim (1500 sats) was
  made via `POST /api/request` and queued (202 pending), but the faucet's
  own payout then failed server-side: `{"status":"failed","code":
  "send_failed","error":"faucet send failed"}`. Verified independently via
  Esplora: the address has 0 UTXOs on chain and in mempool; the faucet's
  onchain budget was not consumed. Per the one-claim cap this was not
  retried.
- `signet.2nd.dev` Ark rails / Mutinynet / Bublina — Ark addresses or
  custom signets only, not default signet tb1q payouts.

The full pipeline — funding check, silent tip construction, broadcast, and
receiver-side scan — is implemented in `scripts/signet-e2e.ts` and in the UI
(**Tip** tab → *Build & broadcast*), and every crypto step it performs is
covered by the vector suite. If the wallet gets funded before the deadline,
first run `node scripts/dist/signet-e2e.mjs rotate-receiver` to replace the
publicly exposed proof receiver without losing the funded sender wallet, and
publish a new signed Nostr binding. Only then may
`node scripts/dist/signet-e2e.mjs tip` broadcast the real transaction; its
txid will be recorded here. Until then the honest status is:
**crypto proven on all 28 official vectors; live signet broadcast pending
funding.**

## 4b. Broadcast proof on local regtest — VERIFIED (not signet)

To prove the send → broadcast → scan path end to end without a faucet,
the app's transaction builder and scanner ran against a local
`bitcoind -regtest` node (`scripts/regtest-e2e.ts`, disposable throwaway
keys and regtest coins only — nothing of value, nothing on a public
network):

- **Funded** the throwaway sender key by mining 101 regtest blocks to the
  `bcrt1` address spending to the same key as `tb1qreve…` (regtest HRP).
- **Built** a BIP-352 silent tip with the repo's own `buildSilentTipTx`:
  5000 sats to a **dedicated regtest-only receiver** `tsp1qqfdna0xv9armxgezqm8jaetp6…`
  (never bound to Nostr, never used on signet — distinct from every promoted
  public identity, which `test/regtest.test.ts` asserts), fee 153 sats.
- **Broadcast** via `sendrawtransaction` and mined it into regtest
  **block 105** (`4816d997…b939`): txid
  `928cdd9afb3fa8504989749dca1fe19fa42ca0e3ee6f8de73f431ccef6e7ad58`.
- **Receiver scan** of that block with the repo's own `scanTransaction`
  found exactly one match — vout 0, 5000 sats — and `(spendPriv + tweak)·G`
  reproduced the output key, i.e. the receiver can spend it.
- The committed fixture `scripts/regtest-proof.json` includes the raw
  broadcast transaction hex (`txHex`, 468 chars) plus the Esplora-shaped
  decode; `test/regtest.test.ts` re-derives the txid from the hex and
  replays the scan so CI re-verifies everything on every run.
- Screencast of the run: `public/regtest-proof.mp4` (21 s).
- Reproduce: `node scripts/dist/regtest-e2e.mjs run` against any
  `bitcoin/bitcoin` regtest container (see the script header).

**What this proves, precisely:** the transaction builder and scanner are the
same code the app uses — UTXO discovery, broadcast transport and block
fetching differ (regtest RPC vs. public Esplora). It is NOT a signet
broadcast claim. Section 4 above still applies: a signet txid is still
pending faucet funding.

## 5b. Rotated / compromised identities — do not tip

Two demo receiver identities are permanently burned; the Tip tab warns when
one resolves (`src/sp/burned.ts`):

| tsp1 | Why burned |
| --- | --- |
| `tsp1qqfjjuye7fjs4l9r73w86pnjr6j5kc93umzrs566p5gzxgj2ha6kycququrg9umwkk4nw2fd70a7w4wx6a9dztn7pqfdgc5kx43rgcprxlyhpz470` | scan/spend keys committed in an early `regtest-proof.json` revision (public git history) |
| `tsp1qq0nekn7ye8ckm9d7unfl9c8w5vqcaup0m2quphwa8r6kfs3c6xs76quvrz2zt43zcmqtgyas9zzjm40800nhkddv88n0drz636awdxvv0yprxu3l` | mnemonic shown on-screen in an early `public/demo.mp4` revision |

Linked npubs (all disposable, never holding funds): `npub1uwc89e8w7gx98hxplr6xmdynnz8vtxl78ltuweks2y8vstws0mtsrt3g3q`, `npub1uu8ffnzr9v97ut3u2spalz499k8vve4hrlxhtpwfmegujzjwplfqj6c8d8`, `npub18lc3g88l79s5ef20duxerpmchgmfyem665fyw5xucxetl540uxgqsq9kmx`, `npub1ryfw69k…`, `npub13pu5hrk…`.

**Revocation blocker:** NIP-09 deletion/replacement of the old binding
events requires the *author nsecs*, which the UI deliberately never
persisted (`src/state.ts` stores only `nostrPubkey`). They are
unrecoverable, so the burned events will keep serving from relays; the fix
is exactly this rotation + the in-app warning + honest labeling. The
88 s demo was recut with the seed phrase masked and captions added; the
regtest proof was regenerated against the dedicated regtest-only receiver
above.

## 5. What is deliberately not claimed

- No mainnet keys, transactions, or funds anywhere.
- No claim that a silent tip has been broadcast until a signet txid exists.
- No claim that the public regtest fixture's receiver key remains private or
  safe to receive future Signet tips.
- The Nostr binding proves *intent to receive*, not custody — the tsp1 keys
  are BIP-352-derived and independent of the nsec that signs the event.
- Silent payments do not hide the sender's inputs; they unlink the
  *recipient* from the payment output.
