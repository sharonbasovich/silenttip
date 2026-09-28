import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import secp from '@bitcoinerlab/secp256k1';
import { SIGNET } from '../sp/network';
import { el, statusEl, copyable, txidLink } from './dom';
import { fetchBinding, resolveIdentifier, DEFAULT_RELAYS } from '../nostr/binding';
import { isSignetSpAddress } from '../sp/keys';
import {
  buildSilentTipTx,
  generateSenderWallet,
  privKeyFromWif,
  walletFromPrivKey,
  wifFromPrivKey,
  type SenderWallet,
} from '../sp/send';
import {
  broadcastTx,
  getAddressUtxos,
  getFeeEstimates,
  type EsploraUtxo,
} from '../chain/esplora';
import { addSentTip, loadState, saveState } from '../state';

export function renderTip(root: HTMLElement): void {
  const panel = el('section', { class: 'panel' });
  root.append(panel);

  panel.append(
    el('h2', {}, 'Send a tip'),
    el('p', { class: 'muted' },
      'Resolve a Nostr identity to its bound tsp1 address, verify the signature, then build a signet transaction whose taproot output is unique to this payment — nothing on-chain links sender to receiver.'),
  );

  // --- resolve recipient ---
  const idInput = el('input', {
    type: 'text',
    placeholder: 'npub1… / name@domain / tsp1…',
  });
  const resolveBtn = el('button', { class: 'btn', type: 'button' }, 'Resolve');
  const resolveStatus = statusEl();
  const bindingBox = el('div');
  let resolvedSp: string | null = null;

  resolveBtn.addEventListener('click', async () => {
    resolveStatus.el.textContent = '';
    bindingBox.replaceChildren();
    resolvedSp = null;
    const input = idInput.value.trim();
    try {
      if (isSignetSpAddress(input)) {
        resolvedSp = input;
        bindingBox.append(
          el('p', { class: 'muted small' },
            'Direct tsp1 address — no Nostr binding checked. (Unverified: anyone can paste any address.)'),
          copyable(input),
        );
        return;
      }
      const pubkey = await resolveIdentifier(input);
      resolveStatus.ok('Resolving binding from relays…');
      const res = await fetchBinding(pubkey, DEFAULT_RELAYS);
      if (!res) throw new Error('No silenttip binding event found for this pubkey');
      if (!res.signatureValid) throw new Error('Binding event signature INVALID — not showing address');
      if (res.binding.network !== 'signet') throw new Error(`Binding is for "${res.binding.network}", this demo is signet-only`);
      resolvedSp = res.binding.sp;
      bindingBox.append(
        el('h3', {}, 'Verified binding'),
        el('div', { class: 'small muted' }, `npub ${npubShort(pubkey)} · kind ${res.event.kind} · ${new Date(res.event.created_at * 1000).toLocaleString()}`),
        copyable(res.binding.sp),
        el('div', { class: 'status ok' }, `signature valid · event ${res.event.id.slice(0, 16)}…`),
      );
      resolveStatus.ok('Binding verified.');
    } catch (e) {
      resolveStatus.err((e as Error).message);
    }
  });

  panel.append(el('label', {}, 'Recipient'), idInput, resolveBtn, resolveStatus.el, bindingBox);

  // --- sender wallet ---
  const walletPanel = el('section', { class: 'panel' });
  root.append(walletPanel);
  walletPanel.append(
    el('h2', {}, 'Sender (test wallet)'),
    el('p', { class: 'muted small' },
      'A single-key P2WPKH signet wallet. Fund it from a signet faucet — links below.'),
  );

  const wifInput = el('input', {
    type: 'password', placeholder: 'import WIF (testnet) or generate', autocomplete: 'off',
  });
  const genWBtn = el('button', { class: 'btn', type: 'button' }, 'Generate test key');
  const importBtn = el('button', { class: 'btn', type: 'button' }, 'Import WIF');
  const walletStatus = statusEl();
  const walletBox = el('div');
  let wallet: SenderWallet | null = null;
  let utxos: EsploraUtxo[] = [];

  const refreshWallet = async () => {
    walletBox.replaceChildren();
    if (!wallet) return;
    walletBox.append(el('label', {}, 'Sender address (fund me)'), copyable(wallet.address));
    walletStatus.ok('Fetching UTXOs…');
    try {
      utxos = await getAddressUtxos(wallet.address);
      const total = utxos.reduce((s, u) => s + u.value, 0);
      walletBox.append(
        el('p', { class: 'small' }, `Balance: ${total.toLocaleString()} sats across ${utxos.length} UTXO(s)`),
        el('p', { class: 'small muted' },
          'Faucets: signetfaucet.com · bitcoinsignetfaucet.com · mempool.space signet faucet'),
      );
      walletStatus.ok('');
      walletStatus.el.textContent = '';
    } catch (e) {
      walletStatus.err((e as Error).message);
    }
  };

  genWBtn.addEventListener('click', () => {
    wallet = generateSenderWallet();
    saveState({ senderWif: wifFromPrivKey(wallet.privKey) });
    wifInput.value = wifFromPrivKey(wallet.privKey);
    void refreshWallet();
  });
  importBtn.addEventListener('click', () => {
    try {
      wallet = walletFromPrivKey(privKeyFromWif(wifInput.value));
      saveState({ senderWif: wifInput.value.trim() });
      void refreshWallet();
    } catch (e) {
      walletStatus.err((e as Error).message);
    }
  });

  const savedWif = loadState().senderWif;
  if (savedWif) {
    try {
      wallet = walletFromPrivKey(privKeyFromWif(savedWif));
      wifInput.value = savedWif;
      void refreshWallet();
    } catch { /* ignore */ }
  }

  walletPanel.append(wifInput, el('div', { class: 'row' }, genWBtn, importBtn), walletStatus.el, walletBox);

  // --- send ---
  const sendPanel = el('section', { class: 'panel' });
  root.append(sendPanel);
  sendPanel.append(el('h2', {}, 'Broadcast'));

  const amountInput = el('input', { type: 'number', min: '546', value: '1000' });
  const staticChk = el('input', { type: 'checkbox', id: 'static-tip' });
  const sendBtn = el('button', { class: 'btn primary', type: 'button' }, 'Build & broadcast tip');
  const sendStatus = statusEl();
  const sendBox = el('div');

  sendBtn.addEventListener('click', async () => {
    sendStatus.el.textContent = '';
    sendBox.replaceChildren();
    try {
      const sats = parseInt(amountInput.value, 10);
      if (!Number.isFinite(sats) || sats < 546) throw new Error('Amount must be ≥ 546 sats');
      if (!wallet) throw new Error('Set up the sender wallet first');
      if (!utxos.length) throw new Error('No UTXOs — fund the sender address first');

      const fees = await getFeeEstimates();
      const rate = Math.max(1, Math.ceil(fees['6'] ?? 1));

      if (staticChk.checked) {
        // honest comparison: a normal tip to the sender's own static address
        const txHex = buildStaticTipTx(wallet, utxos, sats, rate);
        const txid = await broadcastTx(txHex);
        addSentTip({ txid, kind: 'static', amountSats: sats, to: wallet.address, at: Date.now() });
        utxos = await getAddressUtxos(wallet.address);
        sendBox.append(el('p', {}, 'Static tip broadcast: ', txidLink(txid)));
        sendStatus.ok('Static tip sent — see it in "What the chain sees".');
        return;
      }

      if (!resolvedSp) throw new Error('Resolve a recipient first');

      const plan = buildSilentTipTx({
        wallet, utxos, spAddress: resolvedSp, amountSats: sats, feeRateSatVb: rate,
      });
      const txid = await broadcastTx(plan.txHex);
      addSentTip({ txid, kind: 'silent', amountSats: sats, to: resolvedSp, at: Date.now() });
      utxos = await getAddressUtxos(wallet.address);
      sendBox.append(
        el('p', {}, 'Silent tip broadcast: ', txidLink(txid)),
        el('p', { class: 'small muted' },
          `fee ${plan.fee} sats · ${plan.inputs.length} input(s) · SP output index ${plan.silentOutputIndexes.join(', ')}`),
      );
      sendStatus.ok('Broadcast accepted.');
    } catch (e) {
      sendStatus.err((e as Error).message);
    }
  });

  sendPanel.append(
    el('label', {}, 'Amount (sats)'), amountInput,
    el('div', { class: 'small muted', style: 'margin-top:8px' },
      staticChk, ' send a static-address tip instead (builds the comparison cluster)'),
    sendBtn, sendStatus.el, sendBox,
  );
}

function npubShort(hex: string): string {
  return `${hex.slice(0, 10)}…${hex.slice(-4)}`;
}

/** A plain P2WPKH→P2WPKH spend back to ourselves — the "static address" baseline. */
function buildStaticTipTx(
  wallet: SenderWallet,
  utxos: EsploraUtxo[],
  amountSats: number,
  feeRateSatVb: number,
): string {
  const sorted = [...utxos].sort((a, b) => a.value - b.value);
  const psbt = new bitcoin.Psbt({ network: SIGNET });
  const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(wallet.pubKey), network: SIGNET });
  let total = 0;
  const estFee = () => Math.ceil((11 + psbt.txInputs.length * 68 + 31 * 2) * feeRateSatVb);
  for (const u of sorted) {
    psbt.addInput({
      hash: u.txid, index: u.vout,
      witnessUtxo: { script: p2wpkh.output!, value: BigInt(u.value) },
    });
    total += u.value;
    if (total >= amountSats + estFee() + 546) break;
  }
  const fee = estFee();
  if (total < amountSats + fee) throw new Error('insufficient signet funds');
  psbt.addOutput({ address: wallet.address, value: BigInt(amountSats) });
  const change = total - amountSats - fee;
  if (change >= 546) psbt.addOutput({ address: wallet.address, value: BigInt(change) });
  const signer: bitcoin.Signer = {
    publicKey: Buffer.from(wallet.pubKey),
    sign: (h) => Buffer.from(secp.sign(h, wallet.privKey)),
  };
  psbt.signAllInputs(signer);
  psbt.finalizeAllInputs();
  return psbt.extractTransaction().toHex();
}
