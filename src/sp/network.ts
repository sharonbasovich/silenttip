import { networks, type Network } from 'bitcoinjs-lib';

/** Signet shares testnet's address parameters and the `tsp` silent-payment HRP. */
export const SIGNET: Network = networks.testnet;

export const ESPLORA_BASE = 'https://mempool.space/signet/api';

export function mempoolTxUrl(txid: string): string {
  return `https://mempool.space/signet/tx/${txid}`;
}

export function mempoolAddressUrl(address: string): string {
  return `https://mempool.space/signet/address/${address}`;
}
