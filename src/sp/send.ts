import { Buffer } from 'buffer';
import { type PrivateKey } from '@silent-pay/core';
import { createSilentOutputs } from './outputs';
import * as bitcoin from 'bitcoinjs-lib';
import secp from '@bitcoinerlab/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';
import { SIGNET } from './network';
import { decodeSpAddress, isSignetSpAddress } from './keys';
import { smallestOutpoint } from './scan';
import type { EsploraUtxo } from '../chain/esplora';

const base58check = createBase58check(sha256);

bitcoin.initEccLib(secp);

export interface SenderWallet {
  /** 32-byte private key. Test-only — never a real wallet. */
  privKey: Uint8Array;
  /** compressed pubkey */
  pubKey: Uint8Array;
  /** tb1q… P2WPKH signet address */
  address: string;
}

export function generateSenderWallet(): SenderWallet {
  const privKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
  if (!secp.isPrivate(privKey)) throw new Error('invalid key');
  return walletFromPrivKey(privKey);
}

export function walletFromPrivKey(privKey: Uint8Array): SenderWallet {
  if (!secp.isPrivate(privKey)) throw new Error('Invalid private key');
  const pubKey = secp.pointFromScalar(privKey, true)!;
  const { address } = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pubKey), network: SIGNET });
  if (!address) throw new Error('address derivation failed');
  return { privKey, pubKey: new Uint8Array(pubKey), address };
}

/** WIF (base58check, testnet 0xef) decode/encode for the sender test key. */
export function wifFromPrivKey(privKey: Uint8Array): string {
  const payload = new Uint8Array(34);
  payload[0] = 0xef;
  payload.set(privKey, 1);
  payload[33] = 0x01; // compressed
  return base58check.encode(payload);
}

export function privKeyFromWif(wif: string): Uint8Array {
  const payload = base58check.decode(wif.trim());
  if (payload[0] !== 0xef) throw new Error('Not a testnet/signet WIF');
  const key = payload.subarray(1, payload.length === 34 ? 33 : 35);
  if (key.length !== 32 || !secp.isPrivate(new Uint8Array(key))) {
    throw new Error('Invalid WIF');
  }
  return new Uint8Array(key);
}

const P2WPKH_INPUT_VBYTES = 68;
const P2TR_OUTPUT_BYTES = 43;
const P2WPKH_OUTPUT_BYTES = 31;
const TX_OVERHEAD_VBYTES = 11;
const DUST_LIMIT = 546;

export interface SendPlan {
  inputs: EsploraUtxo[];
  outputs: { script: Uint8Array; value: number }[];
  /** SP output index list within outputs (for display). */
  silentOutputIndexes: number[];
  fee: number;
  changeValue: number;
  txHex: string;
  txid: string;
}

/**
 * Build a signet transaction paying `amountSats` to a tsp1 silent-payment
 * address. `utxos` must all belong to `wallet` (single-key demo wallet).
 */
export function buildSilentTipTx(params: {
  wallet: SenderWallet;
  utxos: EsploraUtxo[];
  spAddress: string;
  amountSats: number;
  feeRateSatVb: number;
}): SendPlan {
  const { wallet, utxos, spAddress, amountSats, feeRateSatVb } = params;

  if (!isSignetSpAddress(spAddress)) {
    throw new Error('Recipient must be a signet silent-payment address (tsp1…)');
  }
  decodeSpAddress(spAddress); // validates

  if (utxos.length === 0) throw new Error('No UTXOs — fund the sender address first');

  // smallest-first selection keeps the demo deterministic and simple
  const sorted = [...utxos].sort((a, b) => a.value - b.value);

  const privateKeys: PrivateKey[] = [];
  const inputs: EsploraUtxo[] = [];
  let outputs: { script: Uint8Array; value: number }[] = [];

  const buildFor = (nIn: number) => {
    const chosen = sorted.slice(0, nIn);
    const keys = chosen.map(() => ({ key: bufToHex(wallet.privKey), isXOnly: false }));
    const outs = createSilentOutputs(
      keys,
      smallestOutpoint(chosen),
      [{ address: spAddress.trim(), amount: amountSats }],
      SIGNET,
    );
    if (outs.length === 0) throw new Error('No usable inputs for a silent payment');
    const vsize =
      TX_OVERHEAD_VBYTES +
      nIn * P2WPKH_INPUT_VBYTES +
      outs.length * P2TR_OUTPUT_BYTES +
      P2WPKH_OUTPUT_BYTES; // assume change exists
    const fee = Math.ceil(vsize * feeRateSatVb);
    const total = chosen.reduce((s, u) => s + u.value, 0);
    const change = total - amountSats - fee;
    return { chosen, keys, outs, fee, change, total };
  };

  let plan = buildFor(1);
  while (plan.change < DUST_LIMIT && plan.chosen.length < sorted.length) {
    plan = buildFor(plan.chosen.length + 1);
  }
  if (plan.change < DUST_LIMIT && plan.change !== 0) {
    // drop change output, fold into fee (still above dust edge cases aside)
    plan = buildFor(plan.chosen.length);
    const fee = plan.fee + Math.max(0, plan.change);
    plan = { ...plan, fee, change: 0 };
  }
  if (plan.total < amountSats + plan.fee) {
    throw new Error(`Insufficient funds: have ${plan.total}, need ${amountSats + plan.fee}`);
  }

  privateKeys.push(...plan.keys);
  inputs.push(...plan.chosen);
  outputs = plan.outs;

  const psbt = new bitcoin.Psbt({ network: SIGNET });
  const p2wpkh = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(wallet.pubKey),
    network: SIGNET,
  });
  for (const utxo of inputs) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script: p2wpkh.output!, value: BigInt(utxo.value) },
    });
  }

  const silentOutputIndexes: number[] = [];
  for (const o of outputs) {
    // script is a 33-byte compressed SP pubkey; P2TR commits to its x-only part
    const xOnly = o.script.subarray(1);
    silentOutputIndexes.push(psbt.data.outputs.length);
    psbt.addOutput({
      script: Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.from(xOnly)]),
      value: BigInt(o.value),
    });
  }
  if (plan.change >= DUST_LIMIT) {
    psbt.addOutput({ address: wallet.address, value: BigInt(plan.change) });
  }

  const signer: bitcoin.Signer = {
    publicKey: Buffer.from(wallet.pubKey),
    sign: (hash) => Buffer.from(secp.sign(hash, wallet.privKey)),
  };
  psbt.signAllInputs(signer);
  psbt.finalizeAllInputs();

  const tx = psbt.extractTransaction();
  return {
    inputs,
    outputs,
    silentOutputIndexes,
    fee: plan.fee,
    changeValue: plan.change,
    txHex: tx.toHex(),
    txid: tx.getId(),
  };
}

function bufToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export { bufToHex };
