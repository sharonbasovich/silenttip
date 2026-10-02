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
import { isBurnedSp } from '../sp/burned';
import { TipFlowHost, type BindingView, type TipEvent } from './tipFlow';

// Session-scoped: tab navigation remounts this panel, but in-flight sends and
// resolutions must survive it — see TipFlowHost.
const tipHost = new TipFlowHost({
  resolveIdentifier,
  fetchBinding,
  isSignetSpAddress,
  isBurnedSp,
  getAddressUtxos,
  getFeeEstimates,
  broadcastTx,
  buildSilentTipTx,
  buildStaticTipTx,
  onSentTip: addSentTip,
  relays: DEFAULT_RELAYS,
});

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

  // --- sender wallet ---
  const walletPanel = el('section', { class: 'panel' });
  const wifInput = el('input', {
    type: 'password', placeholder: 'import WIF (testnet) or generate', autocomplete: 'off',
  });
  const genWBtn = el('button', { class: 'btn', type: 'button' }, 'Generate test key');
  const importBtn = el('button', { class: 'btn', type: 'button' }, 'Import WIF');
  const walletStatus = statusEl();
  const walletBox = el('div');

  // --- send ---
  const sendPanel = el('section', { class: 'panel' });
  const amountInput = el('input', { type: 'number', min: '546', value: '1000' });
  const staticChk = el('input', { type: 'checkbox', id: 'static-tip' });
  const sendBtn = el('button', { class: 'btn primary', type: 'button' }, 'Build & broadcast tip');
  const sendStatus = statusEl();
  const sendBox = el('div');

  const flow = tipHost.mount(onFlowEvent);

  function renderBindingView(b: BindingView): void {
    bindingBox.replaceChildren();
    if (b.kind === 'direct') {
      bindingBox.append(
        el('p', { class: 'muted small' },
          'Direct tsp1 address — no Nostr binding checked. (Unverified: anyone can paste any address.)'),
        copyable(b.sp),
      );
    } else {
      bindingBox.append(
        el('h3', {}, 'Verified binding'),
        el('div', { class: 'small muted' },
          `npub ${npubShort(b.pubkey)} · kind ${b.eventKind} · ${new Date(b.createdAt * 1000).toLocaleString()}`),
        copyable(b.sp),
        el('div', { class: 'status ok' }, `signature valid · event ${b.eventId.slice(0, 16)}…`),
      );
    }
    if (b.burned) {
      bindingBox.append(el('div', { class: 'status err' },
        'COMPROMISED demo identity — its private keys were made public; do not tip it.'));
      resolveStatus.err(b.kind === 'verified'
        ? 'Binding is valid but the recipient is a burned demo identity.'
        : 'Recipient is a burned demo identity.');
    } else {
      resolveStatus.ok(b.kind === 'verified' ? 'Binding verified.' : '');
      if (b.kind === 'direct') resolveStatus.el.textContent = '';
    }
  }

  function renderWalletBox(address: string | null, utxos: EsploraUtxo[] | null): void {
    walletBox.replaceChildren();
    if (!address) return;
    walletBox.append(el('label', {}, 'Sender address (fund me)'), copyable(address));
    if (utxos) {
      const total = utxos.reduce((s, u) => s + u.value, 0);
      walletBox.append(
        el('p', { class: 'small' },
          `Balance: ${total.toLocaleString()} sats across ${utxos.length} UTXO(s)`),
        el('p', { class: 'small muted' },
          'Faucets: signetfaucet.com · bitcoinsignetfaucet.com · mempool.space signet faucet'),
      );
    }
  }

  function setSendBusy(busy: boolean): void {
    for (const c of [idInput, resolveBtn, amountInput, staticChk, sendBtn, wifInput, genWBtn, importBtn]) {
      c.disabled = busy;
    }
    // Only paint the busy label; the end-of-busy event must not clobber the
    // sent-*/send-error status already rendered by the flow.
    if (busy) sendStatus.ok('Working…');
  }

  function onFlowEvent(evt: TipEvent): void {
    switch (evt.type) {
      case 'resolve-cleared':
        resolveStatus.el.textContent = '';
        bindingBox.replaceChildren();
        break;
      case 'resolve-progress':
        resolveStatus.ok(evt.message);
        break;
      case 'resolve-applied':
        renderBindingView(evt.binding);
        break;
      case 'resolve-error':
        resolveStatus.err(evt.message);
        break;
      case 'wallet-changed':
        walletStatus.el.textContent = '';
        renderWalletBox(evt.address, null);
        break;
      case 'utxos-pending':
        walletStatus.ok('Fetching UTXOs…');
        break;
      case 'utxos-applied':
        renderWalletBox(evt.address, evt.utxos);
        walletStatus.el.textContent = '';
        break;
      case 'utxos-error':
        walletStatus.err(evt.message);
        break;
      case 'send-busy':
        setSendBusy(evt.busy);
        break;
      case 'send-error':
        sendStatus.err(evt.message);
        break;
      case 'sent-static':
        sendBox.append(el('p', {}, 'Static tip broadcast: ', txidLink(evt.txid)));
        sendStatus.ok('Static tip sent — see it in "What the chain sees".');
        if (evt.storageError) {
          sendBox.append(el('p', { class: 'small muted' },
            `Note: tip history could not be saved locally (${evt.storageError})`));
        }
        break;
      case 'sent-silent':
        sendBox.append(
          el('p', {}, 'Silent tip broadcast: ', txidLink(evt.txid)),
          el('p', { class: 'small muted' },
            `fee ${evt.fee} sats · ${evt.inputCount} input(s) · SP output index ${evt.silentOutputIndexes.join(', ')}`),
        );
        sendStatus.ok('Broadcast accepted.');
        if (evt.storageError) {
          sendBox.append(el('p', { class: 'small muted' },
            `Note: tip history could not be saved locally (${evt.storageError})`));
        }
        break;
    }
  }

  // --- wire interactions ---
  resolveBtn.addEventListener('click', () => void flow.resolve(idInput.value));
  idInput.addEventListener('input', () => flow.recipientEdited(idInput.value));

  panel.append(el('label', {}, 'Recipient'), idInput, resolveBtn, resolveStatus.el, bindingBox);

  root.append(walletPanel);
  walletPanel.append(
    el('h2', {}, 'Sender (test wallet)'),
    el('p', { class: 'muted small' },
      'A single-key P2WPKH signet wallet. Fund it from a signet faucet — links below.'),
  );

  genWBtn.addEventListener('click', () => {
    const wallet = generateSenderWallet();
    saveState({ senderWif: wifFromPrivKey(wallet.privKey) });
    wifInput.value = wifFromPrivKey(wallet.privKey);
    flow.setWallet(wallet);
    void flow.refreshUtxos();
  });
  importBtn.addEventListener('click', () => {
    try {
      const wallet = walletFromPrivKey(privKeyFromWif(wifInput.value));
      saveState({ senderWif: wifInput.value.trim() });
      flow.setWallet(wallet);
      void flow.refreshUtxos();
    } catch (e) {
      walletStatus.err((e as Error).message);
    }
  });

  const savedWif = loadState().senderWif;
  if (savedWif) {
    try {
      const wallet = walletFromPrivKey(privKeyFromWif(savedWif));
      wifInput.value = savedWif;
      flow.setWallet(wallet);
      void flow.refreshUtxos();
    } catch { /* ignore */ }
  }

  walletPanel.append(wifInput, el('div', { class: 'row' }, genWBtn, importBtn), walletStatus.el, walletBox);

  root.append(sendPanel);
  sendPanel.append(el('h2', {}, 'Broadcast'));

  sendBtn.addEventListener('click', () => {
    sendStatus.el.textContent = '';
    sendBox.replaceChildren();
    void flow.send({ sats: parseInt(amountInput.value, 10), staticTip: staticChk.checked });
  });

  sendPanel.append(
    el('label', {}, 'Amount (sats)'), amountInput,
    el('div', { class: 'small muted', style: 'margin-top:8px' },
      staticChk, ' send a static-address tip instead (builds the comparison cluster)'),
    sendBtn, sendStatus.el, sendBox,
  );

  // Re-mount restore: the session-scoped flow may hold a resolution, wallet,
  // in-flight send or last outcome from before this panel's DOM was replaced.
  // Restoring the bound input text keeps the visible field consistent with
  // the validated recipient it refers to.
  const boundText = flow.boundInputText;
  if (boundText) {
    idInput.value = boundText;
    if (flow.bindingView) renderBindingView(flow.bindingView);
  }
  renderWalletBox(flow.walletAddress, flow.utxoList.length ? [...flow.utxoList] : null);
  if (flow.sending) setSendBusy(true);
  if (flow.lastSendOutcome) onFlowEvent(flow.lastSendOutcome);
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
