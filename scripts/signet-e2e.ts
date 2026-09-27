/**
 * Live signet end-to-end run (test keys only — no real funds).
 *
 *   node scripts/dist/signet-e2e.mjs gen      # create + persist throwaway keys
 *   node scripts/dist/signet-e2e.mjs fund     # print faucet instructions
 *   node scripts/dist/signet-e2e.mjs tip      # build + broadcast the silent tip
 *   node scripts/dist/signet-e2e.mjs static   # broadcast an address-reuse tip
 *   node scripts/dist/signet-e2e.mjs scan     # scan recent blocks for our tip
 *
 * State (throwaway signet keys) lives in scripts/.e2e-state.json — gitignored,
 * never committed.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { generateIdentity, toHex, fromHex } from '../src/sp/keys';
import {
  generateSenderWallet,
  wifFromPrivKey,
  privKeyFromWif,
  buildSilentTipTx,
  walletFromPrivKey,
} from '../src/sp/send';
import {
  getAddressUtxos,
  getFeeEstimates,
  broadcastTx,
  getTipHeight,
  getBlockHash,
  getBlockTxids,
  getTxs,
} from '../src/chain/esplora';
import { scanTransaction } from '../src/sp/scan';

const STATE_FILE = new URL('./.e2e-state.json', import.meta.url).pathname;

interface E2EState {
  mnemonic: string;
  tspAddress: string;
  scanPriv: string;
  spendPriv: string;
  senderWif: string;
  senderAddress: string;
  silentTxid?: string;
  staticTxid?: string;
}

function load(): E2EState {
  if (!existsSync(STATE_FILE)) throw new Error('run `gen` first');
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}
function save(s: E2EState) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

const cmd = process.argv[2];

if (cmd === 'gen') {
  const id = generateIdentity();
  const wallet = generateSenderWallet();
  const state: E2EState = {
    mnemonic: id.mnemonic,
    tspAddress: id.address,
    scanPriv: toHex(id.scanPrivKey),
    spendPriv: toHex(id.spendPrivKey),
    senderWif: wifFromPrivKey(wallet.privKey),
    senderAddress: wallet.address,
  };
  save(state);
  console.log('RECEIVER (creator) silent payment address:');
  console.log('  ', state.tspAddress);
  console.log('SENDER demo wallet (P2WPKH, needs signet funds):');
  console.log('  ', state.senderAddress);
  console.log('WIF stored locally in', STATE_FILE);
} else if (cmd === 'fund') {
  const s = load();
  const utxos = await getAddressUtxos(s.senderAddress);
  const total = utxos.reduce((a, u) => a + u.value, 0);
  console.log(`sender ${s.senderAddress} — ${utxos.length} utxos, ${total} sats`);
  if (utxos.length === 0) {
    console.log('\nFund this address at any public signet faucet, e.g.:');
    console.log('  https://signetfaucet.com  (or bitcoinsignetfaucet.com)');
    console.log('  address:', s.senderAddress);
  }
} else if (cmd === 'tip' || cmd === 'static') {
  const s = load();
  const utxos = await getAddressUtxos(s.senderAddress);
  if (utxos.length === 0) throw new Error('no UTXOs — fund the wallet first');
  const feeRate = Math.max(1, Math.ceil((await getFeeEstimates())[1] ?? 1));
  const w = walletFromPrivKey(privKeyFromWif(s.senderWif));

  if (cmd === 'tip') {
    const plan = buildSilentTipTx({
      wallet: w,
      utxos,
      spAddress: s.tspAddress,
      amountSats: 5000,
      feeRateSatVb: feeRate,
    });
    const txid = await broadcastTx(plan.txHex);
    s.silentTxid = txid;
    save(s);
    console.log('SILENT TIP BROADCAST');
    console.log('  txid:', txid);
    console.log('  https://mempool.space/signet/tx/' + txid);
    console.log('  silent outputs at vout:', plan.silentOutputIndexes.join(','));
  } else {
    // static tip: a plain P2WPKH payment to a reused, publicly-known address —
    // the honest on-chain comparison the demo contrasts against
    const bitcoin = await import('bitcoinjs-lib');
    const secp = (await import('@bitcoinerlab/secp256k1')).default;
    const { SIGNET } = await import('../src/sp/network');
    const { Buffer } = await import('buffer');
    const target = w.address; // send to ourselves: same-cluster reuse
    const sorted = [...utxos].sort((a, b) => a.value - b.value);
    const utxo = sorted[0];
    const psbt = new bitcoin.Psbt({ network: SIGNET });
    const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(w.pubKey), network: SIGNET });
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script: p2wpkh.output!, value: BigInt(utxo.value) },
    });
    const fee = Math.ceil(140 * feeRate);
    const change = utxo.value - 5000 - fee;
    if (change < 0) throw new Error('utxo too small');
    psbt.addOutput({ address: target, value: BigInt(5000) });
    if (change >= 546) psbt.addOutput({ address: w.address, value: BigInt(change) });
    psbt.signAllInputs({
      publicKey: Buffer.from(w.pubKey),
      sign: (h: Buffer) => Buffer.from(secp.sign(h, w.privKey)),
    });
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    const txid = await broadcastTx(tx.toHex());
    s.staticTxid = txid;
    save(s);
    console.log('STATIC TIP BROADCAST (address reuse, self-send)');
    console.log('  txid:', txid);
    console.log('  https://mempool.space/signet/tx/' + txid);
  }
} else if (cmd === 'scan') {
  const s = load();
  const tip = await getTipHeight();
  const N = Number(process.argv[3] ?? 10);
  console.log(`tip=${tip}, scanning last ${N} blocks for ${s.tspAddress.slice(0, 20)}…`);
  const scanPriv = fromHex(s.scanPriv);
  const spendPubKey = (await import('@bitcoinerlab/secp256k1')).default.pointFromScalar(
    fromHex(s.spendPriv), true,
  )!;
  for (let h = tip; h > tip - N; h--) {
    const hash = await getBlockHash(h);
    const txids = await getBlockTxids(hash);
    const txs = await getTxs(txids);
    let found = 0;
    for (const tx of txs) {
      const matches = scanTransaction(tx, scanPriv, new Uint8Array(spendPubKey));
      for (const m of matches) {
        found++;
        console.log(`  MATCH tx=${m.txid} vout=${m.vout} value=${m.value} key=${m.outputKey.slice(0, 16)}…`);
      }
    }
    console.log(`  block ${h}: ${txids.length} txs, ${found} matches`);
    if (found > 0) break;
  }
} else {
  console.log('usage: gen|fund|tip|static|scan');
}
