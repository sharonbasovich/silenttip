export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v as unknown as EventListener);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

export function statusEl(): { el: HTMLElement; ok: (m: string) => void; err: (m: string) => void } {
  const s = el('div', { class: 'status' });
  return {
    el: s,
    ok: (m) => { s.className = 'status ok'; s.textContent = m; },
    err: (m) => { s.className = 'status err'; s.textContent = m; },
  };
}

export function copyable(text: string): HTMLElement {
  const span = el('code', { class: 'addr' }, text);
  const btn = el('button', { class: 'btn ghost small', type: 'button' }, 'copy');
  btn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'copied';
    setTimeout(() => (btn.textContent = 'copy'), 1200);
  });
  span.append(' ', btn);
  return span;
}

export function txidLink(txid: string): HTMLAnchorElement {
  return el('a', {
    href: `https://mempool.space/signet/tx/${txid}`,
    target: '_blank',
    rel: 'noopener',
  }, `${txid.slice(0, 12)}…`);
}
