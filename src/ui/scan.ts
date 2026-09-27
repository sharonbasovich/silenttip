import { el, statusEl, txidLink } from './dom';
import {
  getBlockHash,
  getBlockTxids,
  getTipHeight,
  getTxs,
  type EsploraTx,
} from '../chain/esplora';
import { identityFromMnemonic } from '../sp/keys';
import { scanTransaction, type ScanMatch } from '../sp/scan';
import { loadState, saveState } from '../state';

const MAX_BLOCKS = 40;

export function renderScan(root: HTMLElement): void {
  const panel = el('section', { class: 'panel' });
  root.append(panel);

  panel.append(
    el('h2', {}, 'Scan for incoming tips'),
    el('p', { class: 'muted' },
      'Downloads recent signet blocks via Esplora, computes the BIP-352 input tweak for every transaction, and checks its taproot outputs against your scan key. Only your browser does the work — no server learns your address.'),
  );

  const st = loadState();
  const hasIdentity = !!st.mnemonic;

  const blocksInput = el('input', { type: 'number', min: '1', max: String(MAX_BLOCKS), value: '10' });
  const scanBtn = el('button', {
    class: 'btn primary', type: 'button',
    ...(hasIdentity ? {} : { disabled: 'true' }),
  }, 'Scan recent blocks');
  const scanStatus = statusEl();
  const bar = el('div', { class: 'progress' });
  const barFill = el('div');
  bar.append(barFill);
  const resultsBox = el('div');

  if (!hasIdentity) {
    panel.append(el('p', { class: 'warn' }, 'Create or restore an identity on the Receive tab first.'));
  }

  scanBtn.addEventListener('click', async () => {
    resultsBox.replaceChildren();
    barFill.style.width = '0%';
    const n = Math.min(MAX_BLOCKS, Math.max(1, parseInt(blocksInput.value, 10) || 10));
    try {
      const id = identityFromMnemonic(loadState().mnemonic!);
      const tip = await getTipHeight();
      scanStatus.ok(`Scanning blocks ${tip - n + 1}–${tip}…`);

      const found: ScanMatch[] = [];
      for (let h = tip - n + 1; h <= tip; h++) {
        const hash = await getBlockHash(h);
        const txids = await getBlockTxids(hash);
        const txs: EsploraTx[] = await getTxs(txids, 4);
        for (const tx of txs) {
          try {
            found.push(...scanTransaction(tx, id.scanPrivKey, id.spendPubKey));
          } catch {
            // malformed tx — skip, keep scanning
          }
        }
        barFill.style.width = `${((h - (tip - n + 1) + 1) / n) * 100}%`;
        scanStatus.ok(`block ${h} · ${txids.length} txs · ${found.length} match(es) so far`);
      }

      saveState({ found });
      renderFound(resultsBox, found);
      scanStatus.ok(found.length
        ? `Done — found ${found.length} silent-payment output(s).`
        : `Done — no silent-payment outputs for this identity in the last ${n} blocks.`);
    } catch (e) {
      scanStatus.err((e as Error).message);
    }
  });

  panel.append(
    el('label', {}, `Blocks to scan (1–${MAX_BLOCKS}, most recent)`),
    blocksInput, scanBtn, bar, scanStatus.el, resultsBox,
  );

  const prev = loadState().found;
  if (prev?.length) {
    resultsBox.append(el('h3', {}, 'Last scan results'));
    renderFound(resultsBox, prev);
  }
}

function renderFound(box: HTMLElement, found: ScanMatch[]): void {
  const table = el('table', {});
  table.append(
    el('tr', {}, el('th', {}, 'tx'), el('th', {}, 'vout'), el('th', {}, 'sats'), el('th', {}, 'output key')),
  );
  for (const m of found) {
    table.append(
      el('tr', {},
        el('td', { class: 'mono' }, txidLink(m.txid)),
        el('td', { class: 'mono' }, String(m.vout)),
        el('td', { class: 'mono' }, m.value.toLocaleString()),
        el('td', { class: 'mono' }, `${m.outputKey.slice(0, 16)}…`),
      ),
    );
  }
  box.append(table);
}
