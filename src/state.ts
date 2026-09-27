import type { ScanMatch } from './sp/scan';

/** Test-only persisted state. Keys here are SIGNET keys — no real funds. */
const KEY = 'silenttip-state-v1';

export interface StoredTip {
  txid: string;
  kind: 'silent' | 'static';
  amountSats: number;
  to: string;
  at: number;
}

interface Persisted {
  mnemonic?: string;
  senderWif?: string;
  sentTips?: StoredTip[];
  found?: ScanMatch[];
  nostrPubkey?: string;
}

export function loadState(): Persisted {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Persisted;
  } catch {
    return {};
  }
}

export function saveState(patch: Partial<Persisted>): void {
  const next = { ...loadState(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
}

export function addSentTip(tip: StoredTip): void {
  const s = loadState();
  saveState({ sentTips: [...(s.sentTips ?? []), tip] });
}

export function clearState(): void {
  localStorage.removeItem(KEY);
}
