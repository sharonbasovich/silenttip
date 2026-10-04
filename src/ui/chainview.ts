import { el, statusEl, txidLink } from './dom';
import { getTx, type EsploraTx } from '../chain/esplora';
import { loadState } from '../state';

/**
 * "What the chain sees" — renders every output of the transactions we made.
 * Static-address tips reuse the same output script (one visible cluster);
 * silent tips produce unrelated one-time taproot keys.
 */
export function renderChainView(root: HTMLElement): void {
  const panel = el('section', { class: 'panel' });
  root.append(panel);
  panel.append(
    el('h2', {}, 'What the chain sees'),
    el('p', { class: 'muted' },
      'Inspect output scripts from mempool.space signet. Silent-payment outputs avoid direct recipient-address reuse; other linkages may remain. An arbitrary inspected transaction is not evidence of a SilentTip payment.'),
  );

  const input = el('input', {
    type: 'text',
    placeholder: 'paste a txid to inspect (optional)',
  });
  const addBtn = el('button', { class: 'btn', type: 'button' }, 'Inspect tx');
  const st = statusEl();
  const box = el('div');

  const renderTx = async (txid: string, kind?: string) => {
    const tx: EsploraTx = await getTx(txid);
    const wrap = el('div', { class: `cluster ${kind === 'silent' ? 'unlinked' : ''}` });
    wrap.append(
      el('div', { class: 'mono small' }, txidLink(tx.txid), ` ${kind ? `(${kind})` : ''}`),
    );
    const t = el('table', {});
    t.append(el('tr', {}, el('th', {}, '#'), el('th', {}, 'address / script'), el('th', {}, 'sats')));
    tx.vout.forEach((o, i) => {
      const label = o.scriptpubkey_address ??
        `${o.scriptpubkey_type}:${o.scriptpubkey.slice(0, 20)}…`;
      t.append(
        el('tr', {},
          el('td', { class: 'mono' }, String(i)),
          el('td', { class: 'mono' }, o.scriptpubkey_address
            ? el('a', { href: `https://mempool.space/signet/address/${o.scriptpubkey_address}`, target: '_blank', rel: 'noopener' }, label)
            : label),
          el('td', { class: 'mono' }, o.value.toLocaleString()),
        ),
      );
    });
    wrap.append(t);
    box.append(wrap);
  };

  addBtn.addEventListener('click', async () => {
    try {
      await renderTx(input.value.trim());
      st.ok('');
    } catch (e) {
      st.err((e as Error).message);
    }
  });

  panel.append(input, addBtn, st.el, box);

  const tips = loadState().sentTips ?? [];
  if (!tips.length) {
    box.append(el('p', { class: 'muted small' },
      'No tips sent from this browser yet. Send a few in the Tip tab — or inspect any signet txid above.'));
    return;
  }
  const staticTips = tips.filter((t) => t.kind === 'static');
  const silentTips = tips.filter((t) => t.kind === 'silent');
  if (staticTips.length) box.append(el('h3', {}, 'Static-address tips (clusterable)'));
  for (const t of staticTips) void renderTx(t.txid, 'static').catch(() => undefined);
  if (silentTips.length) box.append(el('h3', {}, 'Silent tips (fresh recipient outputs)'));
  for (const t of silentTips) void renderTx(t.txid, 'silent').catch(() => undefined);
}
