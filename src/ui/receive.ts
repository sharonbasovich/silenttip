import { el, statusEl, copyable } from './dom';
import {
  DEFAULT_RELAYS,
  hasNip07,
  newNostrTestKey,
  nsecToPubkey,
  publishEvent,
  signBinding,
  signBindingNip07,
} from '../nostr/binding';
import { generateIdentity, identityFromMnemonic } from '../sp/keys';
import { toHex } from '../sp/keys';
import { loadState, saveState } from '../state';

export function renderReceive(root: HTMLElement): void {
  const state = loadState();
  const panel = el('section', { class: 'panel' });
  root.append(panel);

  panel.append(
    el('h2', {}, 'Receive tips'),
    el(
      'p',
      { class: 'muted' },
      'Generate a Silent Payments identity (independent of your Nostr key), then publish a signed binding event so senders can verify the tsp1 address belongs to your npub.',
    ),
    el(
      'ol',
      { class: 'steps' },
      el('li', {}, 'Create your silent-payment identity (test keys, signet only)'),
      el('li', {}, 'Bind it to your npub with a signed Nostr event (kind 30078)'),
      el('li', {}, 'Share your npub — senders resolve and verify it themselves'),
    ),
  );

  // --- identity ---
  const idStatus = statusEl();
  const idBox = el('div');
  const genBtn = el('button', { class: 'btn primary', type: 'button' }, 'Generate identity');
  genBtn.addEventListener('click', () => {
    const id = generateIdentity();
    saveState({ mnemonic: id.mnemonic });
    renderIdentity(idBox);
    idStatus.ok('New identity generated. Back up the mnemonic — it restores scan/spend keys.');
  });

  const restoreInput = el('input', {
    type: 'password', placeholder: 'restore from 12-word mnemonic (optional)',
    autocomplete: 'off',
  });
  const restoreBtn = el('button', { class: 'btn', type: 'button' }, 'Restore');
  restoreBtn.addEventListener('click', () => {
    try {
      const id = identityFromMnemonic(restoreInput.value);
      saveState({ mnemonic: id.mnemonic });
      renderIdentity(idBox);
      idStatus.ok('Identity restored.');
    } catch (e) {
      idStatus.err((e as Error).message);
    }
  });

  panel.append(genBtn, idStatus.el);
  panel.append(el('label', {}, 'or restore'), restoreInput, restoreBtn, idBox);

  if (state.mnemonic) {
    try {
      renderIdentity(idBox);
    } catch {
      saveState({ mnemonic: undefined });
    }
  }

  // --- publish binding ---
  const pubPanel = el('section', { class: 'panel' });
  root.append(pubPanel);
  pubPanel.append(
    el('h2', {}, 'Publish binding to Nostr'),
    el('p', { class: 'muted small' },
      'Signs a parameterized-replaceable event (kind 30078, d-tag "silenttip") containing your tsp1 address. Re-publishing overwrites it.'),
  );

  const keyInput = el('input', {
    type: 'password',
    placeholder: 'nsec1… (a throwaway test key is fine)',
    autocomplete: 'off',
  });
  const genNsecBtn = el('button', { class: 'btn ghost', type: 'button' }, 'generate throwaway nsec');
  const pubStatus = statusEl();
  const relayList = el('ul', { class: 'relay-list' });
  const pubBtn = el('button', { class: 'btn primary', type: 'button' }, 'Sign & publish binding');

  let throwaway: ReturnType<typeof newNostrTestKey> | null = null;
  genNsecBtn.addEventListener('click', () => {
    throwaway = newNostrTestKey();
    keyInput.value = throwaway.nsec;
    pubStatus.ok(`Generated test npub — this demo uses it to sign.`);
  });

  pubBtn.addEventListener('click', async () => {
    pubStatus.el.textContent = '';
    relayList.replaceChildren();
    try {
      const st = loadState();
      if (!st.mnemonic) throw new Error('Generate an identity first');
      const id = identityFromMnemonic(st.mnemonic);
      const binding = { v: 1, sp: id.address, network: 'signet' as const };

      let event;
      let pubkey: string;
      if (keyInput.value.trim()) {
        const { privKey, pubkey: pk } = nsecToPubkey(keyInput.value);
        event = signBinding(binding, privKey);
        pubkey = pk;
      } else if (hasNip07()) {
        event = await signBindingNip07(binding);
        pubkey = event.pubkey;
      } else {
        throw new Error('Paste a test nsec, click "generate throwaway nsec", or install a NIP-07 signer');
      }

      const results = await publishEvent(event, DEFAULT_RELAYS);
      saveState({ nostrPubkey: pubkey });
      for (const r of results) {
        relayList.append(
          el('li', { class: r.ok ? 'ok' : 'fail' },
            `${r.relay} ${r.ok ? '— accepted' : `— ${r.error}`}`),
        );
      }
      const okCount = results.filter((r) => r.ok).length;
      if (okCount > 0) {
        pubStatus.ok(`Binding published to ${okCount}/${results.length} relays. Event: ${event.id.slice(0, 16)}…`);
      } else {
        pubStatus.err('No relay accepted the event.');
      }
    } catch (e) {
      pubStatus.err((e as Error).message);
    }
  });

  pubPanel.append(
    el('label', {}, 'Nostr secret key (never reused for funds)'),
    keyInput,
    genNsecBtn,
    pubBtn,
    pubStatus.el,
    relayList,
  );
}

function renderIdentity(box: HTMLElement): void {
  const st = loadState();
  if (!st.mnemonic) return;
  const id = identityFromMnemonic(st.mnemonic);
  box.replaceChildren(
    el('label', {}, 'Your silent-payment address (share via Nostr binding)'),
    copyable(id.address),
    el('label', {}, 'Scan pubkey'), el('code', { class: 'addr' }, toHex(id.scanPubKey)),
    el('label', {}, 'Spend pubkey'), el('code', { class: 'addr' }, toHex(id.spendPubKey)),
    el('div', { class: 'warn' },
      'Signet-only test identity. The mnemonic below restores scan+spend keys — do not reuse it for real funds.'),
    el('label', {}, 'Mnemonic (test)'), el('code', { class: 'addr' }, id.mnemonic),
  );
}
