# Judge notes — Cypherpunk-track self-audit

BOSS Battle's Cypherpunk brief: *"make Bitcoin private in practice… Strong
submissions don't just add a privacy feature — they make the private path the
easy path."* This note audits SilentTip's hook against that bar, honestly.

## The hook in one line

> Put one static address in your Nostr profile and get paid on-chain forever —
> without a single payment ever linking back to you.

A judge should be able to repeat the pitch after 10 seconds. The tagline avoids
jargon ("silent payments", "ECDH") up front; the mechanism is one click deeper.

## Does it make the private path the *easy* path?

The baseline for a public tip jar is a reused on-chain address — zero setup, but
it leaks every payment to every observer forever. Today's private alternatives
all demand *more* effort than that: fresh address per payer (coordination per
tip), BIP-47 paycodes + notification transactions (two-way setup, chain
footprint), Lightning zaps (channel liquidity, custodial defaults, still leaks
the invoice receiver).

SilentTip's claim is that the private option is *strictly easier* than every
interactive alternative and equal-effort to the address-reuse default:

| Effort | Static reused address | SilentTip |
| --- | --- | --- |
| Receiver setup | paste 1 address in bio | publish 1 signed event once |
| Per tip | paste same address | paste npub — everything else derived |
| Chain privacy | full income clustering | every tip unlinked, P2TR-native |
| Receiver UX | watch address | scan blocks (or future tweak service) |

The demo is built to *show* this rather than assert it: the "What the chain
sees" tab renders the same tip both ways from real signet data — clustered vs.
unlinked — so the privacy claim is observable, not rhetorical.

## Cypherpunk-fit checklist (self-scored)

- **Privacy as the default, not a feature flag** — the silent-payment path is
  the primary flow; the reused-address tip exists only as the visible
  counter-example.
- **No trusted operator** — Nostr relays and Esplora are used for liveness only.
  Every fetched binding is schnorr-verified in the browser; scanning is local
  cryptography over raw block data. A lying relay can hide data but cannot
  forge a binding.
- **Keys stay separate from identity** — the `tsp1` keys are independent of the
  `nsec` (unlike draft nips#2355). Rotating the payment identity doesn't burn
  the social one, and a leaked Nostr key can't spend anything.
- **Self-custody end to end** — keys are browser-local; no server, no custody,
  no signup.
- **Protocol correctness over demo polish** — all 28 official BIP-352
  send/receive vectors pass, including edge cases the upstream npm package
  gets wrong (K_max, intermediate point-at-infinity sums, eligible-input
  filtering — see `README.md#why-a-local-outputsts`).
- **Honest evidence** — `docs/evidence.md` records exactly what was verified
  (Nostr publish/resolve live on public relays, full spec compliance,
  real signet inspection) and what is not yet (a *broadcast* funded tip —
  blocked only by faucet captcha gating, pending one human faucet run).

## Known weaknesses (no hiding)

- A broadcast silent tip is not yet on signet — the end-to-end path is built
  and vector-verified, but the throwaway wallet needs ~10k faucet sats that
  require a human behind a captcha. We state this rather than simulate it.
- Full-chain scanning is expensive; the demo caps at 40 blocks and says so.
- Sender privacy is out of scope — the sender's P2WPKH input reveals *who*
  tipped, just not *whom*. That asymmetry is itself part of the demo's story.

## If a judge has 30 seconds

1. Open https://sharonbasovich.github.io/silenttip/ — read the one-line hook.
2. Open https://sharonbasovich.github.io/silenttip/video.html — the 90 s
   walkthrough (publish → resolve → what-the-chain-sees → scan).
3. Skim `docs/evidence.md` — every claim is linked to a checkable artifact.
