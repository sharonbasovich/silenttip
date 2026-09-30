import { describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import secp from '@bitcoinerlab/secp256k1';
import { scanTransaction } from '../src/sp/scan';
import { decodeSpAddress, fromHex, toHex } from '../src/sp/keys';
import { BURNED_TSP1, isBurnedSp } from '../src/sp/burned';
import type { EsploraTx } from '../src/chain/esplora';

/**
 * Replays the recorded local-regtest run (scripts/regtest-e2e.ts): a real
 * BIP-352 silent tip was built by the repo's own send path, broadcast to a
 * local bitcoind -regtest node and mined; the committed fixture contains the
 * broadcast transaction and the throwaway receiver keys.
 *
 * REGTEST ONLY — the transaction builder and scanner exercised here are the
 * same code the app uses on signet (UTXO discovery, broadcast transport and
 * block fetching differ); it is not a signet broadcast claim.
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
  receiverRole: string;
  scanPriv: string;
  spendPriv: string;
  txHex: string;
  txEsploraShape: EsploraTx;
}

import proofJson from '../scripts/regtest-proof.json';

const proof = proofJson as RegtestProof;

const CURVE_N = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141',
);

/** Every public receiver identity that has ever been promoted (current +
 *  rotated/burned). The regtest proof receiver must be none of them. */
const PROMOTED_TSP1 = [
  // current promoted creator (fresh, off-camera; binding event created_at 2026-09-29T16:29:46Z)
  'tsp1qq2fp8ruh26d3zwqm9ej6u970sw63cg7jz6g5c4ejek85u6sk9nlkyqesam0wxj0x9wpmvwaf7qvhvk3vkzclyuyjdy7p0wplls4x09lz0se02ypg',
  ...BURNED_TSP1,
];

describe('regtest broadcast proof (local only, disposable keys)', () => {
  it('fixture is honestly labeled regtest, not signet', () => {
    expect(proof.network).toBe('regtest');
    expect(proof.label).toContain('REGTEST');
    expect(proof.label).toContain('not a signet broadcast');
  });

  it('proof receiver is a dedicated regtest-only identity, not any promoted tsp1', () => {
    expect(proof.receiverRole).toContain('regtest-only');
    expect(PROMOTED_TSP1).not.toContain(proof.receiverTsp1);
    expect(isBurnedSp(proof.receiverTsp1)).toBe(false);
  });

  it('raw tx hex decodes to the claimed txid', () => {
    expect(proof.txHex).toMatch(/^[0-9a-f]+$/);
    const tx = bitcoin.Transaction.fromHex(proof.txHex);
    expect(tx.getId()).toBe(proof.txid);
    expect(toHex(new Uint8Array(tx.outs[proof.silentVout].script)))
      .toBe(proof.txEsploraShape.vout[proof.silentVout].scriptpubkey);
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
