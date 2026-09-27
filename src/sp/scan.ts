import {
  createInputHash,
  fromHex,
  toHex,
  type Outpoint,
} from '@silent-pay/core';
import { scanOutputs } from './outputs';
import secp from '@bitcoinerlab/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import type { EsploraTx } from '../chain/esplora';

/** BIP-341 NUMS point H (x-only). Inputs whose internal key is H are skipped. */
const NUMS_H_X =
  '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';

function hex(s: string | undefined): Uint8Array {
  if (!s) return new Uint8Array(0);
  return fromHex(s.length % 2 ? '0' + s : s);
}

function hash160(b: Uint8Array): Uint8Array {
  return ripemd160(sha256(b));
}

function isCompressedPubKey(b: Uint8Array): boolean {
  return b.length === 33 && (b[0] === 0x02 || b[0] === 0x03);
}

function keyHashMatch(candidate: Uint8Array, program: Uint8Array): boolean {
  if (!isCompressedPubKey(candidate)) return false;
  const h = hash160(candidate);
  return h.length === program.length && h.every((b, i) => b === program[i]);
}

/**
 * For a P2TR input, decide whether the input contributes its prevout key.
 * Script-path spends reveal the internal key in the control block; when it
 * is the NUMS point H the input is skipped (BIP-352). Otherwise the taproot
 * output key (from the prevout) is used for both keypath and script-path
 * spends. Returns the 33-byte compressed key 02||x, or null when skipped.
 */
function trInputKey(witness: Uint8Array[], prevoutX: Uint8Array): Uint8Array | null {
  const stack = [...witness];
  const top = stack[stack.length - 1];
  if (stack.length > 1 && top.length > 0 && top[0] === 0x50) stack.pop(); // annex
  if (stack.length > 1) {
    // Script-path spend: last item is the control block, bytes 1:33 are the
    // internal key. If it is the NUMS point H the input is skipped (BIP-352).
    const internalX = stack[stack.length - 1].subarray(1, 33);
    if (toHex(internalX) === NUMS_H_X) return null;
  }
  const key = new Uint8Array(33);
  key[0] = 0x02;
  key.set(prevoutX, 1);
  return key;
}

/**
 * BIP-352 input pubkey extraction.
 * Returns the compressed pubkey that the input contributes to the
 * shared-secret sum, or null when the input is ineligible.
 *
 *   v1_p2tr     — x-only output key from prevout scriptPubKey (unless the
 *                 script-path control block reveals NUMS internal key H)
 *   v0_p2wpkh   — last witness item, hash160-checked against the program
 *   p2sh-p2wpkh — scriptSig must be exactly the p2wpkh redeem push; pubkey
 *                 is the last witness item, hash160-checked
 *   p2pkh       — a 33-byte window of the scriptSig whose hash160 equals the
 *                 prevout hash (malleation-tolerant per BIP-352)
 * Only compressed keys are permitted. Bare P2PK is NOT an eligible input type.
 */
export function extractInputPubKey(
  scriptSigHex: string,
  witnessHexes: string[],
  prevoutScriptHex: string,
): Uint8Array | null {
  const prevout = hex(prevoutScriptHex);
  const scriptSig = hex(scriptSigHex);
  const witness = witnessHexes.map(hex);

  // P2TR: OP_1 <32-byte program>
  if (prevout.length === 34 && prevout[0] === 0x51 && prevout[1] === 0x20) {
    return trInputKey(witness, prevout.subarray(2));
  }

  // P2WPKH: OP_0 <20-byte program>; pubkey is the last witness item
  if (prevout.length === 22 && prevout[0] === 0x00 && prevout[1] === 0x14) {
    const pk = witness[witness.length - 1];
    return pk && keyHashMatch(pk, prevout.subarray(2)) ? pk : null;
  }

  // P2SH-P2WPKH: scriptSig is a single push of the 22-byte v0 program
  if (
    prevout.length === 23 &&
    prevout[0] === 0xa9 &&
    prevout[22] === 0x87 &&
    scriptSig.length === 23 &&
    scriptSig[0] === 0x16 &&
    scriptSig[1] === 0x00 &&
    scriptSig[2] === 0x14
  ) {
    const pk = witness[witness.length - 1];
    return pk && keyHashMatch(pk, scriptSig.subarray(3)) ? pk : null;
  }

  // P2PKH: slide a 33-byte window over the scriptSig; the slice hashing to
  // the prevout hash is the pubkey (tolerates non-standard/malleated
  // scriptSigs exactly like the BIP-352 reference implementation).
  if (
    prevout.length === 25 &&
    prevout[0] === 0x76 &&
    prevout[1] === 0xa9 &&
    prevout[2] === 0x14 &&
    prevout[23] === 0x88 &&
    prevout[24] === 0xac
  ) {
    const target = prevout.subarray(3, 23);
    for (let i = scriptSig.length; i - 33 >= 0; i--) {
      const candidate = scriptSig.subarray(i - 33, i);
      if (keyHashMatch(candidate, target)) return candidate;
    }
    return null;
  }

  return null;
}

/** Serialized outpoint (internal txid order + LE vout) for BIP-352 ordering. */
export function serializeOutpoint(txid: string, vout: number): Uint8Array {
  const h = new Uint8Array(fromHex(txid));
  h.reverse();
  const o = new Uint8Array(36);
  o.set(h, 0);
  new DataView(o.buffer).setUint32(32, vout, true);
  return o;
}

export function smallestOutpoint(vins: { txid: string; vout: number }[]): Outpoint {
  let best: { txid: string; vout: number } | null = null;
  let bestBytes: Uint8Array | null = null;
  for (const vin of vins) {
    const bytes = serializeOutpoint(vin.txid, vin.vout);
    if (!bestBytes || compareBytes(bytes, bestBytes) < 0) {
      best = vin;
      bestBytes = bytes;
    }
  }
  if (!best) throw new Error('no inputs');
  return { txid: best.txid, vout: best.vout };
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Sum eligible input pubkeys for a transaction.
 * Returns null when no input is eligible or the *final* sum is the point at
 * infinity (BIP-352: such transactions carry no silent payment). An
 * intermediate sum of infinity is permitted — later inputs still count.
 */
export function sumInputPubKeys(
  inputs: { scriptSigHex: string; witnessHexes: string[]; prevoutScriptHex: string }[],
): Uint8Array | null {
  let sum: Uint8Array | null = null;
  let started = false;
  for (const input of inputs) {
    const pk = extractInputPubKey(
      input.scriptSigHex,
      input.witnessHexes,
      input.prevoutScriptHex,
    );
    if (!pk) continue;
    if (!started || sum === null) {
      sum = pk;
      started = true;
      continue;
    }
    try {
      const next = secp.pointAdd(sum, pk);
      sum = next === null ? null : new Uint8Array(next);
    } catch {
      sum = null; // running sum hit the point at infinity
    }
  }
  return started ? sum : null;
}

export interface ScanMatch {
  txid: string;
  vout: number;
  value: number;
  /** x-only output pubkey hex. */
  outputKey: string;
  /** private-key tweak hex: spending key = spendPriv + tweak (mod n). */
  tweak: string;
}

/** True when the scriptPubKey is a segwit output with version > 1. */
function isSegwitV2Plus(scriptHex: string): boolean {
  const spk = hex(scriptHex);
  // OP_2..OP_16 push a 2..40-byte program
  return (
    spk.length >= 4 &&
    spk.length <= 42 &&
    spk[0] >= 0x52 &&
    spk[0] <= 0x60 &&
    spk[1] === spk.length - 2
  );
}

/** Scan one transaction's P2TR outputs. Returns matches for our keys. */
export function scanTransaction(
  tx: EsploraTx,
  scanPrivKey: Uint8Array,
  spendPubKey: Uint8Array,
): ScanMatch[] {
  const spendableVins = tx.vin.filter((vin) => !vin.is_coinbase && vin.prevout);
  // BIP-352: a transaction spending any segwit version > 1 output is skipped
  // entirely — an unknown input type could follow rules we can't reproduce.
  if (spendableVins.some((vin) => isSegwitV2Plus(vin.prevout!.scriptpubkey))) {
    return [];
  }
  const inputs = spendableVins.map((vin) => ({
    scriptSigHex: vin.scriptsig,
    witnessHexes: vin.witness ?? [],
    prevoutScriptHex: vin.prevout!.scriptpubkey,
  }));
  const sum = sumInputPubKeys(inputs);
  if (!sum) return [];

  const spendable = tx.vin.filter((v) => !v.is_coinbase);
  const inputHash = createInputHash(sum, smallestOutpoint(spendable));

  const outputs = tx.vout
    .filter(
      (o) =>
        o.scriptpubkey_type === 'v1_p2tr' &&
        o.scriptpubkey.length === 68 &&
        o.scriptpubkey.startsWith('5120'),
    )
    .map((o) => fromHex('02' + o.scriptpubkey.slice(4)));

  if (outputs.length === 0) return [];

  const matches = scanOutputs(scanPrivKey, spendPubKey, sum, inputHash, outputs);
  const found: ScanMatch[] = [];
  for (const [outputHex, tweak] of matches) {
    const xOnly = outputHex.slice(2);
    const index = tx.vout.findIndex(
      (o) => o.scriptpubkey_type === 'v1_p2tr' && o.scriptpubkey.slice(4) === xOnly,
    );
    if (index === -1) continue;
    found.push({
      txid: tx.txid,
      vout: index,
      value: tx.vout[index].value,
      outputKey: xOnly,
      tweak: toHex(tweak),
    });
  }
  return found;
}

export function scanTransactions(
  txs: EsploraTx[],
  scanPrivKey: Uint8Array,
  spendPubKey: Uint8Array,
): ScanMatch[] {
  return txs.flatMap((tx) => scanTransaction(tx, scanPrivKey, spendPubKey));
}
