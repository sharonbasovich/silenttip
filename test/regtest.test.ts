import { describe, expect, it } from 'vitest';
import secp from '@bitcoinerlab/secp256k1';
import { scanTransaction } from '../src/sp/scan';
import { decodeSpAddress, fromHex, toHex } from '../src/sp/keys';
import type { EsploraTx } from '../src/chain/esplora';

/**
 * Replays the recorded local-regtest run (scripts/regtest-e2e.ts): a real
 * BIP-352 silent tip was built by the repo's own send path, broadcast to a
 * local bitcoind -regtest node and mined; the committed fixture contains the
 * broadcast transaction and the throwaway receiver keys.
 *
 * REGTEST ONLY — this proves the exact code path used on signet; it is not
 * a signet broadcast claim.
 */
interface RegtestProof {
  network: string;
  label: string;
  txid: string;
  amountSats: number;
  silentVout: number;
  outputKey: string;
  tweak: string;
  receiverTsp1: string;
  scanPriv: string;
  spendPriv: string;
  txEsploraShape: EsploraTx;
}

import proofJson from '../scripts/regtest-proof.json';

const proof = proofJson as RegtestProof;

const CURVE_N = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141',
);

describe('regtest broadcast proof (local only, disposable keys)', () => {
  it('fixture is honestly labeled regtest, not signet', () => {
    expect(proof.network).toBe('regtest');
    expect(proof.label).toContain('REGTEST');
    expect(proof.label).toContain('not a signet broadcast');
  });

  it('receiver scan detects the broadcast silent output', () => {
    const dec = decodeSpAddress(proof.receiverTsp1);
    const matches = scanTransaction(
      proof.txEsploraShape,
      fromHex(proof.scanPriv),
      dec.spendKey,
    );
    expect(matches.length).toBe(1);
    const m = matches[0];
    expect(m.txid).toBe(proof.txid);
    expect(m.vout).toBe(proof.silentVout);
    expect(m.value).toBe(proof.amountSats);
    expect(m.outputKey).toBe(proof.outputKey);
    expect(m.tweak).toBe(proof.tweak);
  });

  it('tweak yields a spendable output key: (spendPriv + tweak)·G', () => {
    const out = (
      (BigInt('0x' + proof.spendPriv) + BigInt('0x' + proof.tweak)) % CURVE_N
    ).toString(16).padStart(64, '0');
    const pub = secp.pointFromScalar(fromHex(out), true)!;
    expect(toHex(new Uint8Array(pub).subarray(1))).toBe(proof.outputKey);
  });

  it('the silent output is a P2TR key unlike the receiver tsp1 keys', () => {
    const out = proof.txEsploraShape.vout[proof.silentVout];
    expect(out.scriptpubkey_type).toBe('v1_p2tr');
    expect(out.scriptpubkey.startsWith('5120')).toBe(true);
    expect(out.scriptpubkey.slice(4)).toBe(proof.outputKey);
    // nothing in the tx reveals the tsp1 scan/spend keys
    const dec = decodeSpAddress(proof.receiverTsp1);
    expect(out.scriptpubkey.slice(4)).not.toBe(toHex(dec.scanKey).slice(2));
    expect(out.scriptpubkey.slice(4)).not.toBe(toHex(dec.spendKey).slice(2));
  });
});
