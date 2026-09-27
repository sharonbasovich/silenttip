import { describe, expect, it } from 'vitest';
import vectors from './vectors/send_and_receive_test_vectors.json';
import {
  createInputHash,
  createTaggedHash,
  fromHex,
  serialiseUint32,
  toHex,
  type LabelMap,
  type PrivateKey,
} from '@silent-pay/core';
import secp from '@bitcoinerlab/secp256k1';
import { networks } from 'bitcoinjs-lib';
import {
  extractInputPubKey,
  smallestOutpoint,
  sumInputPubKeys,
} from '../src/sp/scan';
import { createSilentOutputs, scanOutputs } from '../src/sp/outputs';

/**
 * The official BIP-352 send_and_receive test vectors, vendored from
 * bitcoin/bips (bip-0352/send_and_receive_test_vectors.json). Every case
 * runs through the same helpers the app uses: our outpoint ordering,
 * our input-pubkey extraction, and @silent-pay/core's crypto.
 */

interface VectorVin {
  txid: string;
  vout: number;
  scriptSig: string;
  txinwitness: string;
  prevout: { scriptPubKey: { hex: string } };
  private_key?: string;
}

interface VectorCase {
  comment: string;
  sending: {
    given: {
      vin: VectorVin[];
      recipients: { address: string; count?: number }[];
    };
    expected: { outputs: string[][]; input_pub_keys?: string[] };
  }[];
  receiving: {
    given: {
      vin: VectorVin[];
      outputs: string[];
      key_material: { scan_priv_key: string; spend_priv_key: string };
      labels?: number[];
    };
    expected: {
      outputs?: { pub_key: string; priv_key_tweak: string }[];
      n_outputs?: number;
      input_pub_key_sum?: string;
    };
  }[];
}

const cases = vectors as unknown as VectorCase[];

function parseWitnessStack(hex: string): string[] {
  if (!hex) return [];
  const b = fromHex(hex);
  const items: string[] = [];
  let i = 0;
  const readVar = () => {
    const f = b[i++];
    if (f < 0xfd) return f;
    if (f === 0xfd) {
      const v = b[i] | (b[i + 1] << 8);
      i += 2;
      return v;
    }
    throw new Error('unsupported varint');
  };
  const count = readVar();
  for (let n = 0; n < count; n++) {
    const len = readVar();
    items.push(toHex(b.subarray(i, i + len)));
    i += len;
  }
  return items;
}

function sendingPrivKeys(vin: VectorVin[]): PrivateKey[] {
  return vin.map((v) => {
    if (!v.private_key) throw new Error('vector missing private_key');
    return { key: v.private_key, isXOnly: v.prevout.scriptPubKey.hex.startsWith('5120') };
  });
}

function receivingInputs(vin: VectorVin[]) {
  return vin.map((v) => ({
    scriptSigHex: v.scriptSig,
    witnessHexes: parseWitnessStack(v.txinwitness),
    prevoutScriptHex: v.prevout.scriptPubKey.hex,
  }));
}

/** BIP-352 label map: { labelPointHex: labelScalarHex } for label ints. */
function buildLabelMap(scanPrivKey: Uint8Array, labels: number[]): LabelMap {
  const map: LabelMap = {};
  for (const m of labels) {
    const labelScalar = createTaggedHash(
      'BIP0352/Label',
      new Uint8Array([...scanPrivKey, ...serialiseUint32(m)]),
    );
    const labelPoint = secp.pointFromScalar(labelScalar, true)!;
    map[toHex(labelPoint)] = toHex(labelScalar);
  }
  return map;
}

describe('BIP-352 test vectors — sending', () => {
  cases.forEach((c, ci) => {
    c.sending.forEach((s, si) => {
      it(`case ${ci}.${si}: ${c.comment}`, () => {
        // The sender may only use keys whose pubkey is extractable from
        // the input (BIP-352 eligible-input list), same as the reference impl
        const eligibleVins = s.given.vin.filter(
          (v) =>
            extractInputPubKey(
              v.scriptSig,
              parseWitnessStack(v.txinwitness),
              v.prevout.scriptPubKey.hex,
            ) !== null,
        );
        if (s.expected.input_pub_keys) {
          const pubs = eligibleVins.map((v) =>
            toHex(
              extractInputPubKey(
                v.scriptSig,
                parseWitnessStack(v.txinwitness),
                v.prevout.scriptPubKey.hex,
              )!,
            ),
          );
          expect(pubs).toEqual(s.expected.input_pub_keys);
        }
        const keys = sendingPrivKeys(eligibleVins);
        // `count` expands one entry into that many identical recipients
        const recipients = s.given.recipients.flatMap((r) =>
          Array.from({ length: r.count ?? 1 }, () => ({
            address: r.address,
            amount: 0,
          })),
        );
        const expectedSets = s.expected.outputs;

        let outputs: { script: Uint8Array; value: number }[] = [];
        let threw = false;
        try {
          outputs = createSilentOutputs(
            keys,
            smallestOutpoint(s.given.vin),
            recipients,
            networks.bitcoin,
          );
        } catch {
          threw = true;
        }
        const expectsNone =
          expectedSets.length === 0 || expectedSets.every((s2) => s2.length === 0);
        if (expectsNone) {
          // BIP-352: the send fails outright (e.g. zero key-sum, K_max)
          expect(
            threw || outputs.length === 0,
            'sending must produce no outputs',
          ).toBe(true);
        } else {
          expect(threw).toBe(false);
          // expected.outputs enumerates every valid output set (the vectors
          // list all orderings when labels make ordering observable)
          const got = new Set(outputs.map((o) => toHex(o.script.subarray(1))));
          const ok = expectedSets.some(
            (set) =>
              set.length === got.size && set.every((e) => got.has(e)),
          );
          expect(ok, 'produced outputs must match one expected set').toBe(true);
        }
      });
    });
  });
});

describe('BIP-352 test vectors — receiving', () => {
  cases.forEach((c, ci) => {
    c.receiving.forEach((r, ri) => {
      it(`case ${ci}.${ri}: ${c.comment}`, () => {
        const scanPriv = fromHex(r.given.key_material.scan_priv_key);
        const spendPriv = fromHex(r.given.key_material.spend_priv_key);
        const spendPub = new Uint8Array(secp.pointFromScalar(spendPriv, true)!);

        const sum = sumInputPubKeys(receivingInputs(r.given.vin));
        if (sum === null) {
          expect(r.expected.outputs?.length ?? 0).toBe(0);
          return;
        }
        if (r.expected.input_pub_key_sum) {
          expect(toHex(sum)).toBe(r.expected.input_pub_key_sum);
        }

        const inputHash = createInputHash(
          sum,
          smallestOutpoint(r.given.vin),
        );

        const labels = r.given.labels?.length
          ? buildLabelMap(scanPriv, r.given.labels)
          : undefined;

        const outputs = r.given.outputs.map((o) => fromHex('02' + o));
        const matches = scanOutputs(scanPriv, spendPub, sum, inputHash, outputs, labels);

        if (r.expected.n_outputs !== undefined && !r.expected.outputs) {
          // K_max case: scanner must stop at the per-group limit
          expect(matches.size).toBe(r.expected.n_outputs);
          return;
        }

        const expectedPubs = (r.expected.outputs ?? []).map((o) => o.pub_key);
        const gotPubs = [...matches.keys()].map((k) => k.slice(2));
        expect([...gotPubs].sort()).toEqual([...expectedPubs].sort());
        for (const [pubHex, tweak] of matches) {
          const exp = (r.expected.outputs ?? []).find(
            (o) => o.pub_key === pubHex.slice(2),
          );
          expect(exp, `expected tweak for ${pubHex}`).toBeDefined();
          expect(toHex(tweak)).toBe(exp!.priv_key_tweak);
        }
      });
    });
  });
});
