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
- **Binding event published from the hosted site:**
  `3a6e4460e1dfea21…` (kind 30078, `d`=`silenttip`), accepted by all
  three relays; author `npub18lc3g88l79s5ef20duxerpmchgmfyem665fyw5xucxetl540uxgqsq9kmx`,
  binding `tsp1qq0nekn7ye8ckm9d7unfl9c8w5vqcaup0m2quphwa8r6kfs3c6xs76quvrz2zt43zcmqtgyas9zzjm40800nhkddv88n0drz636awdxvv0yprxu3l`.
  The Tip tab re-resolved this npub to the same tsp1 address with a valid
  schnorr signature.
- **Two more bindings published from the hosted site on 2026-09-28** (visible
  in the `video.html` walkthrough): `252f504ff529dd5d…` (3/3 relays) and
  `4b7c717b8e55b832…` (damus.io + primal; nos.lol timed out).

## 2. Nostr binding — a real, verifiable event on public relays

A kind-30078 (NIP-78 parameterized replaceable) event with `d` tag
`silenttip` was signed and published from the SilentTip UI to public relays
on 2026-09-27:

- **Event id:** `cb29c2ee12baf50a84c301aed11c40ec5762f517bfed56d5512f2ef2ba4ee1b0`
- **Author:** `npub1uwc89e8w7gx98hxplr6xmdynnz8vtxl78ltuweks2y8vstws0mtsrt3g3q`
- **Content:** `{"v":1,"sp":"tsp1qqfjjuye7fjs4l9r73w86pnjr6j5kc93umzrs566p5gzxgj2ha6kycququrg9umwkk4nw2fd70a7w4wx6a9dztn7pqfdgc5kx43rgcprxlyhpz470","network":"signet"}`
- **Accepted by:** `wss://relay.damus.io`, `wss://relay.primal.net` (nos.lol timed out)

**Demo-only binding — receiver keys exposed:** The regtest proof fixture below
publishes the scan and spend private keys for this exact `tsp1qqfjju…` address.
Anyone can derive spending keys for a future output to it. The signed Nostr
event remains valid evidence that publication and signature verification work,
but this receiver address must never receive a funded Signet tip. Publish a
new signed binding to a fresh, privately held receiver before such a run.

Verify it yourself:

```
# any Nostr client or nak:
nak req -k 30078 -d silenttip wss://relay.damus.io
```

The **Tip** tab resolves `npub1uwc89e…` by fetching this event from relays and
verifying the schnorr signature over the tsp1 binding in-browser.
Screenshot: `docs/screenshots/tip-resolve-verified.jpg`.

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

To prove the exact send → broadcast → scan path end to end without a faucet,
the same code ran against a local `bitcoind -regtest` node
(`scripts/regtest-e2e.ts`, disposable throwaway keys and regtest coins only —
nothing of value, nothing on a public network):

- **Funded** the throwaway sender key by mining 101 regtest blocks to the
  `bcrt1` address spending to the same key as `tb1qreve…` (regtest HRP).
- **Built** a BIP-352 silent tip with the repo's own `buildSilentTipTx`:
  5000 sats to `tsp1qqfjjuye…`, fee 153 sats.
- **Broadcast** via `sendrawtransaction` and mined it into regtest
  **block 103**: txid `44e2677292eff91f5428737d7702d4c7c5238be6121f86434631c80e54616beb`.
- **Receiver scan** of that block with the repo's own `scanTransaction`
  found exactly one match — vout 0, 5000 sats — and `(spendPriv + tweak)·G`
  reproduced the output key, i.e. the receiver can spend it.
- Screencast of the run: `public/regtest-proof.mp4` (24 s); the committed
  fixture `scripts/regtest-proof.json` is replayed by `test/regtest.test.ts`
  so CI re-verifies the scan and tweak math on every run.
- The fixture intentionally contains **public disposable receiver private
  keys** to make the proof replayable. Its `tsp1qqfjju…` address is the same
  one in the public Nostr binding above and is permanently unsafe for any
  future funded Signet use. The normal app generates fresh, private keys;
  the proof identity is an exception used only for this test.
- Reproduce: `node scripts/dist/regtest-e2e.mjs run` against any
  `bitcoin/bitcoin` regtest container (see the script header).

**This is a regtest proof of the identical code path — it is NOT claimed to
be a signet broadcast.** Section 4 above still applies: a signet txid is
still pending faucet funding.

## 5. What is deliberately not claimed

- No mainnet keys, transactions, or funds anywhere.
- No claim that a silent tip has been broadcast until a signet txid exists.
- No claim that the public regtest fixture's receiver key remains private or
  safe to receive future Signet tips.
- The Nostr binding proves *intent to receive*, not custody — the tsp1 keys
  are BIP-352-derived and independent of the nsec that signs the event.
- Silent payments do not hide the sender's inputs; they unlink the
  *recipient* from the payment output.
