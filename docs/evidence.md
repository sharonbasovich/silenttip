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

## 2. Nostr binding — a real, verifiable event on public relays

A kind-30078 (NIP-78 parameterized replaceable) event with `d` tag
`silenttip` was signed and published from the SilentTip UI to public relays
on 2026-09-27:

- **Event id:** `cb29c2ee12baf50a84c301aed11c40ec5762f517bfed56d5512f2ef2ba4ee1b0`
- **Author:** `npub1uwc89e8w7gx98hxplr6xmdynnz8vtxl78ltuweks2y8vstws0mtsrt3g3q`
- **Content:** `{"v":1,"sp":"tsp1qqfjjuye7fjs4l9r73w86pnjr6j5kc93umzrs566p5gzxgj2ha6kycququrg9umwkk4nw2fd70a7w4wx6a9dztn7pqfdgc5kx43rgcprxlyhpz470","network":"signet"}`
- **Accepted by:** `wss://relay.damus.io`, `wss://relay.primal.net` (nos.lol timed out)

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
(`tb1qreve5pu58jj7y8gej3akgfsse2vnfw6xhf6q2j`) is unfunded: every public
signet faucet was either behind a login, a CAPTCHA that blocks automated
browsers, or down, at demo-build time.

The full pipeline — funding check, silent tip construction, broadcast, and
receiver-side scan — is implemented in `scripts/signet-e2e.ts` and in the UI
(**Tip** tab → *Build & broadcast*), and every crypto step it performs is
covered by the vector suite. If the wallet gets funded before the deadline,
`node scripts/dist/signet-e2e.mjs tip` broadcasts the real transaction and
its txid will be recorded here. Until then the honest status is:
**crypto proven on all 28 official vectors; live signet broadcast pending
funding.**

## 5. What is deliberately not claimed

- No mainnet keys, transactions, or funds anywhere.
- No claim that a silent tip has been broadcast until a signet txid exists.
- The Nostr binding proves *intent to receive*, not custody — the tsp1 keys
  are BIP-352-derived and independent of the nsec that signs the event.
- Silent payments do not hide the sender's inputs; they unlink the
  *recipient* from the payment output.
