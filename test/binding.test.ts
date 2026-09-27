import { Buffer } from 'buffer';
import { describe, expect, it } from 'vitest';
import { getPublicKey, verifyEvent } from 'nostr-tools';
import {
  buildBindingEvent,
  newNostrTestKey,
  npubToHex,
  nsecToPubkey,
  resolveIdentifier,
  signBinding,
  BINDING_D_TAG,
  BINDING_KIND,
} from '../src/nostr/binding';
import { nip19 } from 'nostr-tools';
import { generateIdentity, identityFromMnemonic, decodeSpAddress } from '../src/sp/keys';
import { privKeyFromWif, walletFromPrivKey, wifFromPrivKey } from '../src/sp/send';
import { smallestOutpoint, serializeOutpoint, extractInputPubKey } from '../src/sp/scan';

describe('silent payment identity', () => {
  it('generates a tsp1 address with stable keys', () => {
    const id = generateIdentity();
    expect(id.address.startsWith('tsp1')).toBe(true);
    const dec = decodeSpAddress(id.address);
    expect(dec.scanKey).toEqual(id.scanPubKey);
    expect(dec.spendKey).toEqual(id.spendPubKey);
    // same mnemonic restores identical identity
    const id2 = identityFromMnemonic(id.mnemonic);
    expect(id2.address).toBe(id.address);
  });

  it('SP keys are independent of any nsec (design check)', () => {
    const id = generateIdentity();
    const nkey = newNostrTestKey();
    expect(id.scanPubKey).not.toEqual(nkey.privKey);
    expect(id.address.startsWith('tsp1')).toBe(true);
  });
});

describe('nostr binding events', () => {
  it('builds, signs and verifies a kind-30078 binding', () => {
    const key = newNostrTestKey();
    const id = generateIdentity();
    const ev = signBinding({ v: 1, sp: id.address, network: 'signet' }, key.privKey);
    expect(ev.kind).toBe(BINDING_KIND);
    expect(ev.tags.find((t) => t[0] === 'd')?.[1]).toBe(BINDING_D_TAG);
    expect(verifyEvent(ev)).toBe(true);
    expect(ev.pubkey).toBe(key.pubkey);
    expect(JSON.parse(ev.content).sp).toBe(id.address);
  });

  it('nsec round-trips to the right pubkey', () => {
    const key = newNostrTestKey();
    const { privKey, pubkey } = nsecToPubkey(key.nsec);
    expect(pubkey).toBe(key.pubkey);
    expect(getPublicKey(privKey)).toBe(key.pubkey);
    const npub = nip19.npubEncode(key.pubkey);
    expect(npubToHex(npub)).toBe(key.pubkey);
  });

  it('rejects non-nsec and non-npub identifiers', async () => {
    await expect(resolveIdentifier('not-an-identifier')).rejects.toThrow();
  });

  it('buildBindingEvent template contains the required fields', () => {
    const t = buildBindingEvent({ v: 1, sp: 'tsp1qqdemo', network: 'signet' });
    expect(t.kind).toBe(BINDING_KIND);
    expect(t.tags).toContainEqual(['d', BINDING_D_TAG]);
    expect(JSON.parse(t.content).network).toBe('signet');
  });
});

describe('sender key handling', () => {
  it('WIF round-trip and tb1q address', () => {
    const w = walletFromPrivKey(new Uint8Array(32).fill(7));
    expect(w.address.startsWith('tb1q')).toBe(true);
    const wif = wifFromPrivKey(w.privKey);
    const back = privKeyFromWif(wif);
    expect(back).toEqual(w.privKey);
    expect(walletFromPrivKey(back).address).toBe(w.address);
  });

  it('rejects mainnet WIF', () => {
    // 0x80-prefixed mainnet WIF
    const mainnetWif = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn';
    expect(() => privKeyFromWif(mainnetWif)).toThrow();
  });
});

describe('outpoint ordering (BIP-352)', () => {
  it('orders lexicographically on serialized bytes', () => {
    const a = serializeOutpoint(
      'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16', 0);
    const b = serializeOutpoint(
      'a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d', 0);
    const min = smallestOutpoint([
      { txid: 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16', vout: 0 },
      { txid: 'a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d', vout: 0 },
    ]);
    // serialized little-endian: 0xa107.. reverses to bytes starting 8dd4.., 0xf418.. reverses to 169e.. → f418 is smaller
    expect(min.txid).toBe('f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16');
    expect(a.length).toBe(36);
    expect(b.length).toBe(36);
  });

  it('breaks txid ties on vout', () => {
    const txid = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16';
    const min = smallestOutpoint([
      { txid, vout: 3 },
      { txid, vout: 1 },
    ]);
    expect(min.vout).toBe(1);
  });
});

describe('input pubkey extraction', () => {
  it('extracts x-only p2tr key as 02||x', () => {
    const x = '5a1e61f898173040e20616d43e9f496fba90338a39faa1ed98fcbaeee4dd9be5';
    const pk = extractInputPubKey('', [], '5120' + x);
    expect(pk).not.toBeNull();
    expect(pk!.length).toBe(33);
    expect(pk![0]).toBe(0x02);
    expect(Buffer.from(pk!.subarray(1)).toString('hex')).toBe(x);
  });

  it('skips non-eligible scripts', () => {
    // p2wsh prevout
    expect(extractInputPubKey('', [], '0020' + 'ab'.repeat(32))).toBeNull();
    // arbitrary p2sh (non-p2wpkh redeem)
    expect(extractInputPubKey('00493046', [], 'a914' + '00'.repeat(20) + '87')).toBeNull();
    // bare multisig
    expect(extractInputPubKey('', [], '5221' + '02'.repeat(33) + '52ae')).toBeNull();
  });
});
