import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  decodeSilentPaymentAddress,
  encodeSilentPaymentAddress,
  fromHex,
  toHex,
} from '@silent-pay/core';
import secp from '@bitcoinerlab/secp256k1';
import { networks } from 'bitcoinjs-lib';
import { SIGNET } from './network';

/**
 * SilentTip derives the two BIP-352 keys from a dedicated seed under
 * m/352'/1'/0'/0/{0=scan,1=spend}. BIP-352 does not mandate a derivation
 * scheme; this path is documented so the identity is recoverable from the
 * mnemonic alone. Keys are independent of any Nostr key by design.
 */
export const SCAN_PATH = "m/352'/1'/0'/0/0";
export const SPEND_PATH = "m/352'/1'/0'/0/1";

export interface SpIdentity {
  mnemonic: string;
  scanPrivKey: Uint8Array;
  spendPrivKey: Uint8Array;
  scanPubKey: Uint8Array;
  spendPubKey: Uint8Array;
  /** bech32m silent payment address (tsp1… on signet/testnet params). */
  address: string;
}

export function generateIdentity(): SpIdentity {
  return identityFromMnemonic(generateMnemonic(wordlist, 128));
}

export function identityFromMnemonic(mnemonic: string): SpIdentity {
  const normalized = mnemonic.trim().toLowerCase();
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error('Invalid mnemonic');
  }
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(normalized));
  const scan = root.derive(SCAN_PATH);
  const spend = root.derive(SPEND_PATH);
  if (!scan.privateKey || !spend.privateKey) {
    throw new Error('Key derivation failed');
  }
  const scanPubKey = new Uint8Array(secp.pointFromScalar(scan.privateKey, true)!);
  const spendPubKey = new Uint8Array(secp.pointFromScalar(spend.privateKey, true)!);
  const address = encodeSilentPaymentAddress(scanPubKey, spendPubKey, SIGNET);
  return {
    mnemonic: normalized,
    scanPrivKey: new Uint8Array(scan.privateKey),
    spendPrivKey: new Uint8Array(spend.privateKey),
    scanPubKey,
    spendPubKey,
    address,
  };
}

export function decodeSpAddress(address: string): { scanKey: Uint8Array; spendKey: Uint8Array } {
  const trimmed = address.trim();
  if (trimmed.startsWith('sp1')) {
    // mainnet-HRP addresses are decoded for vector tests only; the UI forbids them
    return decodeSilentPaymentAddress(trimmed, networks.bitcoin);
  }
  return decodeSilentPaymentAddress(trimmed, SIGNET);
}

export function isSignetSpAddress(address: string): boolean {
  return address.trim().startsWith('tsp1');
}

export { fromHex, toHex };
