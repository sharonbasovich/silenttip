/**
 * Local regtest end-to-end proof (test keys + regtest coins only — no real
 * funds, no network faucet). Runs against a local bitcoind -regtest node in
 * the `st-regtest` Docker container (bitcoin/bitcoin image):
 *
 *   docker run -d --name st-regtest bitcoin/bitcoin:27.2 \
 *     -regtest -server=1 -rpcuser=st -rpcpassword=stregtest \
 *     -fallbackfee=0.0002 -txindex=1
 *   node scripts/dist/regtest-e2e.mjs run
 *
 * `run` is idempotent: mines 101 blocks to the throwaway sender wallet if
 * unfunded, builds a real BIP-352 silent-payment transaction with the repo's
 * own send path, broadcasts it to regtest, mines a block, then runs the
 * repo's own scanner over that block and verifies the receiver detects the
 * output and derives the matching spending key.
 *
 * Proof artifacts are written to scripts/regtest-proof.json (committed) —
 * the fixture the regtest vitest replays. The sender comes from the shared
 * throwaway state file (scripts/dist/.e2e-state.json, gitignored); the
 * RECEIVER is a dedicated regtest-only identity (scripts/dist/
 * .regtest-state.json, gitignored) that is never bound to Nostr and never
 * used on signet — publishing its keys is therefore harmless.
 *
 * REGTEST ONLY. The transaction builder and scanner are the same code the
 * app uses (UTXO discovery, broadcast transport and block fetching differ:
 * scantxoutset/sendrawtransaction/getblock vs Esplora). This is not, and is
 * never presented as, a signet broadcast.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import secp from '@bitcoinerlab/secp256k1';
import { fromHex, toHex, generateIdentity } from '../src/sp/keys';
import {
  privKeyFromWif,
  walletFromPrivKey,
  buildSilentTipTx,
} from '../src/sp/send';
import { scanTransaction, type ScanMatch } from '../src/sp/scan';
import type { EsploraTx, EsploraUtxo } from '../src/chain/esplora';

const CLI = 'docker';
const CONTAINER = 'st-regtest';
const BASE_ARGS = [
  'exec', CONTAINER, 'bitcoin-cli',
  '-regtest', '-rpcuser=st', '-rpcpassword=stregtest',
];
const STATE_FILE = new URL('./.e2e-state.json', import.meta.url).pathname;
const RECEIVER_FILE = new URL('./.regtest-state.json', import.meta.url).pathname;
const PROOF_FILE = new URL('../regtest-proof.json', import.meta.url).pathname;

function rpc<T>(method: string, ...params: (string | number | boolean)[]): T {
  const out = execFileSync(CLI, [...BASE_ARGS, method, ...params.map(String)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(out) as T;
  } catch {
    return out.trim() as T; // sendrawtransaction returns a bare txid
  }
}

interface E2EState {
  mnemonic: string;
  tspAddress: string;
  scanPriv: string;
  spendPriv: string;
  senderWif: string;
  senderAddress: string;
}

/** Dedicated regtest-only receiver: never bound to Nostr, never used on
 * signet, so publishing its keys in the committed fixture is harmless and
 * keeps the proof self-verifying. Distinct from every promoted identity. */
interface RegtestReceiver {
  mnemonic: string;
  tspAddress: string;
  scanPriv: string;
  spendPriv: string;
}

function regtestReceiver(): RegtestReceiver {
  if (existsSync(RECEIVER_FILE)) {
    return JSON.parse(readFileSync(RECEIVER_FILE, 'utf8')) as RegtestReceiver;
  }
  const id = generateIdentity();
  const r: RegtestReceiver = {
    mnemonic: id.mnemonic,
    tspAddress: id.address,
    scanPriv: toHex(id.scanPrivKey),
    spendPriv: toHex(id.spendPrivKey),
  };
  writeFileSync(RECEIVER_FILE, JSON.stringify(r, null, 2));
  return r;
}

/** Map bitcoind scriptPubKey type strings to Esplora scriptpubkey_type. */
const TYPE_MAP: Record<string, string> = {
  witness_v1_taproot: 'v1_p2tr',
  witness_v0_keyhash: 'v0_p2wpkh',
  witness_v0_scripthash: 'v0_p2wsh',
  pubkeyhash: 'p2pkh',
  scripthash: 'p2sh',
  pubkey: 'p2pk',
  nulldata: 'op_return',
};

interface CoreVin {
  txid?: string;
  vout?: number;
  scriptSig?: { hex?: string };
  txinwitness?: string[];
  coinbase?: string;
  prevout?: { scriptPubKey?: { hex?: string; type?: string }; value?: number };
}
interface CoreTx {
  txid: string;
  version: number;
  locktime: number;
  vin: CoreVin[];
  vout: { n: number; value: number; scriptPubKey: { hex: string; type: string } }[];
}

export function coreTxToEsplora(tx: CoreTx): EsploraTx {
  return {
    txid: tx.txid,
    version: tx.version,
    locktime: tx.locktime,
    vin: tx.vin.map((v) => ({
      txid: v.txid ?? '0'.repeat(64),
      vout: v.vout ?? 0xffffffff,
      prevout: v.prevout?.scriptPubKey?.hex
        ? {
            scriptpubkey: v.prevout.scriptPubKey.hex,
            scriptpubkey_type: TYPE_MAP[v.prevout.scriptPubKey.type ?? ''] ?? 'unknown',
            value: Math.round((v.prevout.value ?? 0) * 1e8),
          }
        : null,
      scriptsig: v.scriptSig?.hex ?? '',
      witness: v.txinwitness ?? [],
      is_coinbase: v.coinbase !== undefined,
    })),
    vout: tx.vout.map((o) => ({
      scriptpubkey: o.scriptPubKey.hex,
      scriptpubkey_type: TYPE_MAP[o.scriptPubKey.type] ?? 'unknown',
      value: Math.round(o.value * 1e8),
    })),
    status: { confirmed: true },
  };
}

function walletUtxos(pubKeyHex: string): EsploraUtxo[] {
  const desc = rpc<{ descriptor: string }>('getdescriptorinfo', `wpkh(${pubKeyHex})`).descriptor;
  const res = rpc<{ unspents: { txid: string; vout: number; amount: number; height: number }[] }>(
    'scantxoutset', 'start',
    JSON.stringify([{ desc }]),
  );
  const tip = rpc<{ blocks: number }>('getblockchaininfo').blocks;
  // coinbase maturity: only outputs ≥100 confs are spendable
  return res.unspents
    .filter((u) => tip - u.height >= 99)
    .map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: Math.round(u.amount * 1e8),
      status: { confirmed: true, block_height: u.height },
    }));
}

const cmd = process.argv[2];

if (cmd === 'run') {
  if (!existsSync(STATE_FILE)) throw new Error('run signet-e2e gen first — need throwaway keys');
  const s: E2EState = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const receiver = regtestReceiver();
  const wallet = walletFromPrivKey(privKeyFromWif(s.senderWif));
  const pubHex = toHex(wallet.pubKey);

  // bcrt1 address spending to the same key as our tb1q sender
  const descInfo = rpc<{ descriptor: string }>('getdescriptorinfo', `wpkh(${pubHex})`);
  const desc = descInfo.descriptor; // includes #checksum
  const [bcrt] = rpc<string[]>('deriveaddresses', desc);

  const info = rpc<{ blocks: number }>('getblockchaininfo');
  console.log(`[regtest] chain height ${info.blocks}; sender ${s.senderAddress} (bcrt: ${bcrt})`);

  if (info.blocks < 101) {
    console.log('[regtest] mining 101 blocks to sender wallet…');
    rpc<string[]>('generatetoaddress', '101', bcrt);
  }

  const utxos = walletUtxos(pubHex);
  const total = utxos.reduce((a, u) => a + u.value, 0);
  console.log(`[regtest] sender UTXOs: ${utxos.length} (${total} sats)`);
  if (total === 0) throw new Error('sender unfunded after mining — is this the right wallet?');

  const amountSats = 5000;
  const plan = buildSilentTipTx({
    wallet,
    utxos,
    spAddress: receiver.tspAddress,
    amountSats,
    feeRateSatVb: 1,
  });
  console.log(`[regtest] built tip tx ${plan.txid}: ${plan.inputs.length} in, ` +
    `silent output at vout ${plan.silentOutputIndexes.join(',')}, fee ${plan.fee} sats`);

  const txid = rpc<string>('sendrawtransaction', plan.txHex);
  if (txid !== plan.txid) throw new Error(`broadcast txid mismatch: ${txid}`);
  console.log(`[regtest] BROADCAST txid ${txid}`);

  const [blockHash] = rpc<string[]>('generatetoaddress', '1', bcrt);
  const height = rpc<{ height: number }>('getblockheader', blockHash).height;
  console.log(`[regtest] confirmed in block ${height} (${blockHash.slice(0, 16)}…)`);

  // Receiver scan: convert the block's transactions and run the repo scanner
  const block = rpc<{ tx: CoreTx[] }>('getblock', blockHash, '3');
  const scanPriv = fromHex(receiver.scanPriv);
  const spendPubKey = new Uint8Array(secp.pointFromScalar(fromHex(receiver.spendPriv), true)!);
  const matches: ScanMatch[] = [];
  for (const tx of block.tx) {
    matches.push(...scanTransaction(coreTxToEsplora(tx), scanPriv, spendPubKey));
  }
  console.log(`[regtest] receiver scan of block ${height}: ${matches.length} silent-payment output(s) found`);
  const tip = matches.find((m) => m.txid === txid);
  if (!tip) throw new Error('scan failed to detect our broadcast tip');
  console.log(`[regtest] MATCH vout=${tip.vout} value=${tip.value} sats outputKey=${tip.outputKey.slice(0, 20)}…`);

  // The tweak must yield a valid spending key: (spendPriv + tweak)·G == outputKey
  const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
  const spendPrivBig = BigInt('0x' + toHex(fromHex(receiver.spendPriv)));
  const tweakBig = BigInt('0x' + tip.tweak);
  const outPriv = (spendPrivBig + tweakBig) % n;
  const outPrivHex = outPriv.toString(16).padStart(64, '0');
  const derived = secp.pointFromScalar(fromHex(outPrivHex), true)!;
  const derivedX = toHex(new Uint8Array(derived).subarray(1));
  if (derivedX !== tip.outputKey) throw new Error('tweak does not derive the output key');
  console.log(`[regtest] spendable: (spendPriv + tweak)·G reproduces output key ✓`);

  const tipTx = block.tx.find((t) => t.txid === txid)!;
  const proof = {
    network: 'regtest',
    label: 'LOCAL REGTEST ONLY — not a signet broadcast',
    blockHeight: height,
    blockHash,
    txid,
    amountSats,
    silentVout: tip.vout,
    outputKey: tip.outputKey,
    tweak: tip.tweak,
    senderAddress: s.senderAddress,
    receiverTsp1: receiver.tspAddress,
    receiverRole: 'regtest-only, never bound to Nostr or used on signet',
    // throwaway keys of the dedicated regtest-only receiver — committed so the
    // fixture is self-contained and the tweak math is reproducible by anyone
    scanPriv: receiver.scanPriv,
    spendPriv: receiver.spendPriv,
    txHex: plan.txHex,
    txEsploraShape: coreTxToEsplora(tipTx),
  };
  writeFileSync(PROOF_FILE, JSON.stringify(proof, null, 2));
  console.log(`[regtest] proof written to ${PROOF_FILE}`);
  console.log('RESULT: BIP-352 send → broadcast → receiver scan verified on regtest.');
} else {
  console.log('usage: node scripts/dist/regtest-e2e.mjs run');
}
