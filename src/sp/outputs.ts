import {
  createInputHash,
  createTaggedHash,
  decodeSilentPaymentAddress,
  fromHex,
  serialiseUint32,
  toHex,
  type LabelMap,
  type Outpoint,
  type PrivateKey,
} from '@silent-pay/core';
import secp from '@bitcoinerlab/secp256k1';
import { networks, type Network } from 'bitcoinjs-lib';

/**
 * BIP-352 output creation and scanning, implemented directly against the
 * spec (reference.py semantics) because @silent-pay/core@0.0.6 does not
 * enforce the per-group K_max recipient limit and throws when an
 * intermediate private-key sum is zero.
 */

/** Maximum silent payment addresses sharing one scan key (BIP-352). */
export const K_MAX = 2323;

const CURVE_N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);

function bytesToInt(b: Uint8Array): bigint {
  return BigInt('0x' + toHex(b));
}

function intToBytes(i: bigint): Uint8Array {
  return fromHex(i.toString(16).padStart(64, '0'));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function negatePoint(p: Uint8Array): Uint8Array {
  const n = new Uint8Array(p);
  n[0] ^= 1; // 0x02 <-> 0x03
  return n;
}

function validScalar(b: Uint8Array): bigint {
  const i = bytesToInt(b);
  if (i === 0n || i >= CURVE_N) throw new Error('invalid scalar');
  return i;
}

function checkTweak(t: Uint8Array): bigint {
  return validScalar(t);
}

export interface CreatedOutput {
  /** 33-byte compressed silent-payment pubkey (x-only part goes into P2TR). */
  script: Uint8Array;
  value: number;
}

/**
 * Create silent payment outputs for `recipients`, following BIP-352 exactly:
 * x-only private keys are negated to the even-Y secret, private keys are
 * summed mod n (intermediate zero sums are permitted — only a zero *final*
 * sum fails), and any scan-key group larger than K_max aborts the send.
 * Returns [] when the send must produce no outputs.
 */
export function createSilentOutputs(
  inputPrivateKeys: PrivateKey[],
  outpoint: Outpoint,
  recipients: { address: string; amount: number }[],
  network: Network = networks.testnet,
): CreatedOutput[] {
  let a = 0n;
  for (const k of inputPrivateKeys) {
    const kb = fromHex(k.key);
    let s = bytesToInt(kb);
    if (k.isXOnly && secp.pointFromScalar(kb, true)![0] === 0x03) {
      s = CURVE_N - s; // use the even-Y secret for taproot inputs
    }
    a = (a + s) % CURVE_N;
  }
  if (a === 0n) return [];

  const A = secp.pointFromScalar(intToBytes(a), true)!;
  const inputHash = createInputHash(new Uint8Array(A), outpoint);
  const ih = bytesToInt(inputHash);
  if (ih === 0n || ih >= CURVE_N) return [];

  const groups = new Map<
    string,
    { scanKey: Uint8Array; spends: { spendKey: Uint8Array; amount: number }[] }
  >();
  for (const r of recipients) {
    const { scanKey, spendKey } = decodeSilentPaymentAddress(r.address, network);
    const hex = toHex(scanKey);
    const g = groups.get(hex) ?? { scanKey, spends: [] };
    g.spends.push({ spendKey, amount: r.amount });
    groups.set(hex, g);
  }
  for (const g of groups.values()) {
    if (g.spends.length > K_MAX) return [];
  }

  const ecdhScalar = intToBytes((a * ih) % CURVE_N);
  const outputs: CreatedOutput[] = [];
  for (const g of groups.values()) {
    const ecdh = secp.pointMultiply(g.scanKey, ecdhScalar, true)!;
    let k = 0;
    for (const { spendKey, amount } of g.spends) {
      const t = createTaggedHash(
        'BIP0352/SharedSecret',
        concat(ecdh, serialiseUint32(k)),
      );
      checkTweak(t);
      const P = secp.pointAddScalar(spendKey, t)!;
      outputs.push({ script: new Uint8Array(P), value: amount });
      k++;
    }
  }
  return outputs;
}

/**
 * Scan candidate taproot output keys (33-byte compressed) for payments to
 * (scanPrivKey, spendPubKey). Follows the BIP-352 scanning loop: k counts up
 * from 0, a match removes the output and rescans with k++, no match at a k
 * stops the scan, and k never reaches K_max. `labels` maps compressed
 * label-point hex to the label scalar hex (BIP-352 Label tagged hash).
 */
export function scanOutputs(
  scanPrivKey: Uint8Array,
  spendPubKey: Uint8Array,
  inputPubKeySum: Uint8Array,
  inputHash: Uint8Array,
  outputs: Uint8Array[],
  labels?: LabelMap,
): Map<string, Uint8Array> {
  const s = (bytesToInt(inputHash) * bytesToInt(scanPrivKey)) % CURVE_N;
  const ecdh = secp.pointMultiply(inputPubKeySum, intToBytes(s), true)!;

  const matches = new Map<string, Uint8Array>();
  const remaining = [...outputs];

  for (let k = 0; k < K_MAX; k++) {
    const t = createTaggedHash(
      'BIP0352/SharedSecret',
      concat(ecdh, serialiseUint32(k)),
    );
    const ti = checkTweak(t);
    const P = secp.pointAddScalar(spendPubKey, t)!;
    const Px = P.subarray(1);

    let found = false;
    for (let i = 0; i < remaining.length; i++) {
      const out = remaining[i];
      if (out.subarray(1).every((b, j) => b === Px[j])) {
        matches.set(toHex(out), new Uint8Array(t));
        remaining.splice(i, 1);
        found = true;
        break;
      }
      if (labels) {
        const negP = negatePoint(P);
        const candidates: (Uint8Array | null)[] = [null, null];
        try {
          candidates[0] = secp.pointAdd(out, negP);
        } catch {
          /* invalid point */
        }
        try {
          candidates[1] = secp.pointAdd(negatePoint(out), negP);
        } catch {
          /* invalid point */
        }
        const labelHex = candidates
          .map((c) => (c ? labels[toHex(c)] : undefined))
          .find((v) => v !== undefined);
        if (labelHex) {
          const full = (ti + bytesToInt(fromHex(labelHex))) % CURVE_N;
          matches.set(toHex(out), intToBytes(full));
          remaining.splice(i, 1);
          found = true;
          break;
        }
      }
    }
    if (!found) break;
  }
  return matches;
}
