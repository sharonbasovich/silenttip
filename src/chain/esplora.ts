import { ESPLORA_BASE } from '../sp/network';

export interface EsploraPrevout {
  scriptpubkey: string;
  scriptpubkey_type: string;
  scriptpubkey_address?: string;
  value: number;
}

export interface EsploraVin {
  txid: string;
  vout: number;
  prevout: EsploraPrevout | null;
  scriptsig: string;
  scriptsig_asm?: string;
  witness?: string[];
  is_coinbase?: boolean;
  sequence?: number;
}

export interface EsploraVout {
  scriptpubkey: string;
  scriptpubkey_type: string;
  scriptpubkey_address?: string;
  value: number;
}

export interface EsploraTx {
  txid: string;
  version: number;
  locktime: number;
  vin: EsploraVin[];
  vout: EsploraVout[];
  status?: { confirmed: boolean; block_height?: number; block_hash?: string };
}

export interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

const BASE = ESPLORA_BASE;

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    throw new Error(`Esplora ${path} -> HTTP ${res.status}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

export function getTipHeight(): Promise<number> {
  return get<number>('/blocks/tip/height');
}

export function getFeeEstimates(): Promise<Record<string, number>> {
  return get<Record<string, number>>('/fee-estimates');
}

export function getAddressUtxos(address: string): Promise<EsploraUtxo[]> {
  return get<EsploraUtxo[]>(`/address/${address}/utxo`);
}

export function getTx(txid: string): Promise<EsploraTx> {
  return get<EsploraTx>(`/tx/${txid}`);
}

export function getTxHex(txid: string): Promise<string> {
  return get<string>(`/tx/${txid}/hex`);
}

export function getBlockHash(height: number): Promise<string> {
  return get<string>(`/block-height/${height}`);
}

export function getBlockTxids(hash: string): Promise<string[]> {
  return get<string[]>(`/block/${hash}/txids`);
}

export async function broadcastTx(hex: string): Promise<string> {
  const res = await fetch(`${BASE}/tx`, { method: 'POST', body: hex });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`broadcast failed: ${res.status} ${text}`);
  }
  return text.trim(); // txid
}

/** Fetch a list of txids with bounded concurrency. */
export async function getTxs(txids: string[], concurrency = 4): Promise<EsploraTx[]> {
  const out: EsploraTx[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < txids.length) {
      const i = cursor++;
      out[i] = await getTx(txids[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, txids.length) }, worker));
  return out;
}
