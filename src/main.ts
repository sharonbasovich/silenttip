import { Buffer } from 'buffer';
(globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;

import './style.css';
import { el } from './ui/dom';
import { renderReceive } from './ui/receive';
import { renderTip } from './ui/tip';
import { renderScan } from './ui/scan';
import { renderChainView } from './ui/chainview';

type Tab = 'receive' | 'tip' | 'scan' | 'chain';

const TABS: { id: Tab; label: string; render: (r: HTMLElement) => void }[] = [
  { id: 'receive', label: 'Receive', render: renderReceive },
  { id: 'tip', label: 'Tip', render: renderTip },
  { id: 'scan', label: 'Scan', render: renderScan },
  { id: 'chain', label: 'What the chain sees', render: renderChainView },
];

const app = document.getElementById('app')!;

app.append(
  el('header', { class: 'hero' },
    el('span', { class: 'badge' }, 'signet only · no real funds'),
    el('h1', {}, el('span', { class: 'accent' }, 'Silent'), 'Tip'),
    el('p', { class: 'tagline' },
      'Put one static address in your Nostr profile and get paid on-chain forever — without a single payment ever linking back to you. BIP-352 silent payments, verified in your browser.'),
  ),
);

const nav = el('nav', { class: 'tabs' });
const content = el('main', {});
app.append(nav, content);

function show(tab: Tab): void {
  for (const b of nav.querySelectorAll('button')) b.classList.remove('active');
  nav.querySelector(`button[data-tab="${tab}"]`)?.classList.add('active');
  content.replaceChildren();
  TABS.find((t) => t.id === tab)!.render(content);
}

for (const t of TABS) {
  const b = el('button', { 'data-tab': t.id, type: 'button' }, t.label);
  b.addEventListener('click', () => show(t.id));
  nav.append(b);
}

show('receive');
