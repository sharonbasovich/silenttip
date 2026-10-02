import { describe, it, expect, vi } from 'vitest';
import { TipFlow, type TipDeps, type TipEvent } from '../src/ui/tipFlow';
import type { ResolvedBinding } from '../src/nostr/binding';
import type { EsploraUtxo } from '../src/chain/esplora';
import type { SendPlan, SenderWallet } from '../src/sp/send';
import type { StoredTip } from '../src/state';
import { BURNED_TSP1 } from '../src/sp/burned';

// Deterministic mock harness: every external effect (relays, Esplora,
// broadcast, tx building) is injected and deferred — no network, no real keys,
// no chain calls.

const SP_A = 'tsp1qq' + 'a'.repeat(150);
const SP_B = 'tsp1qq' + 'b'.repeat(150);
const WALLET_A: SenderWallet = { privKey: new Uint8Array(32).fill(1), pubKey: new Uint8Array(33).fill(2), address: 'tb1q' + 'a'.repeat(38) };
const WALLET_B: SenderWallet = { privKey: new Uint8Array(32).fill(3), pubKey: new Uint8Array(33).fill(4), address: 'tb1q' + 'b'.repeat(38) };
const UTXO_A: EsploraUtxo = { txid: 'a'.repeat(64), vout: 0, value: 50_000, status: { confirmed: true } };
const UTXO_B: EsploraUtxo = { txid: 'b'.repeat(64), vout: 0, value: 60_000, status: { confirmed: true } };

function deferred<T>() {
  let res!: (v: T) => void;
  let rej!: (e: Error) => void;
  const p = new Promise<T>((r, j) => { res = r; rej = j; });
  return { p, res, rej };
}

function bindingFor(sp: string, pubkey = 'pk'): ResolvedBinding {
  return {
    event: {
      id: 'e'.repeat(64), pubkey, created_at: 1_759_200_000, kind: 30078,
      tags: [['d', 'silenttip']], content: '{}', sig: 's'.repeat(128),
    },
    binding: { v: 1, sp, network: 'signet' },
    pubkey,
    signatureValid: true,
  } as ResolvedBinding;
}

function plan(sp: string): SendPlan {
  return {
    inputs: [UTXO_A],
    outputs: [{ script: new Uint8Array(34), value: 1_000 }],
    silentOutputIndexes: [0],
    fee: 200,
    changeValue: 40_000,
    txHex: `hex-for-${sp.slice(0, 12)}`,
    txid: 't'.repeat(64),
  };
}

interface Harness {
  flow: TipFlow;
  deps: TipDeps;
  events: TipEvent[];
  sent: StoredTip[];
}

function harness(overrides: Partial<TipDeps> = {}): Harness {
  const events: TipEvent[] = [];
  const sent: StoredTip[] = [];
  const deps: TipDeps = {
    resolveIdentifier: vi.fn(async (i: string) => `pk-${i}`),
    fetchBinding: vi.fn(async (pk: string) => bindingFor(pk.includes('B') ? SP_B : SP_A, pk)),
    isSignetSpAddress: (s: string) => s.startsWith('tsp1'),
    isBurnedSp: (s: string) => (BURNED_TSP1 as readonly string[]).includes(s),
    getAddressUtxos: vi.fn(async (addr: string) => (addr === WALLET_A.address ? [UTXO_A] : [UTXO_B])),
    getFeeEstimates: vi.fn(async () => ({ '6': 2 })),
    broadcastTx: vi.fn(async () => 'txid-' + '9'.repeat(58)),
    buildSilentTipTx: vi.fn(({ spAddress }: { spAddress: string }) => plan(spAddress)),
    buildStaticTipTx: vi.fn(() => 'static-hex'),
    onSentTip: (t: StoredTip) => sent.push(t),
    relays: ['wss://relay.example'],
    ...overrides,
  };
  return { deps, events, sent, flow: new TipFlow(deps, (e) => events.push(e)) };
}

function ofType<T extends TipEvent['type']>(
  evts: TipEvent[],
  t: T,
): Extract<TipEvent, { type: T }>[] {
  return evts.filter((e): e is Extract<TipEvent, { type: T }> => e.type === t);
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('TipFlow recipient resolution', () => {
  it('invalidates the resolution when the input is edited without re-resolving', async () => {
    const { flow, deps, events } = harness();
    await flow.resolve('npubA');
    expect(flow.resolvedSp).toBe(SP_A);

    flow.recipientEdited('npubB');
    expect(flow.resolvedSp).toBeNull();
    expect(ofType(events, 'resolve-cleared').at(-1)?.reason).toBe('edited');

    flow.setWallet(WALLET_A);
    await flow.refreshUtxos();
    await flow.send({ sats: 1000, staticTip: false });
    expect(deps.broadcastTx).not.toHaveBeenCalled();
    expect(ofType(events, 'send-error').at(-1)?.message).toBe('Resolve a recipient first');
  });

  it('an out-of-order slow resolve cannot overwrite a newer resolution', async () => {
    const slowA = deferred<ResolvedBinding | null>();
    const { flow, events } = harness({
      fetchBinding: vi.fn((pk: string) =>
        pk === 'pk-npubA' ? slowA.p : Promise.resolve(bindingFor(SP_B, pk))),
    });
    const pa = flow.resolve('npubA');
    await flush();                         // A suspended awaiting fetchBinding
    await flow.resolve('npubB');           // B completes first
    expect(flow.resolvedSp).toBe(SP_B);

    slowA.res(bindingFor(SP_A, 'pk-npubA')); // stale A finishes late
    await pa;
    await flush();
    expect(flow.resolvedSp).toBe(SP_B);
    expect(ofType(events, 'resolve-applied')).toHaveLength(1);
  });

  it('an edited input cancels an in-flight resolve for the old text', async () => {
    const slow = deferred<ResolvedBinding | null>();
    const { flow, events } = harness({ fetchBinding: vi.fn(() => slow.p) });
    void flow.resolve('npubA');
    await flush();
    flow.recipientEdited('npubB');           // edit mid-flight
    slow.res(bindingFor(SP_A, 'pk-npubA'));
    await flush();
    expect(flow.resolvedSp).toBeNull();
    expect(ofType(events, 'resolve-applied')).toHaveLength(0);
  });

  it('invalid or burned supersession cannot be resurrected by a slow prior resolve', async () => {
    const slow = deferred<ResolvedBinding | null>();
    const { flow, events } = harness({
      resolveIdentifier: vi.fn(async (i: string) => {
        if (i === 'bad') throw new Error('cannot resolve identifier');
        return `pk-${i}`;
      }),
      fetchBinding: vi.fn(() => slow.p),
    });
    // Case 1: fast invalid B while slow A is in flight
    void flow.resolve('npubA');
    await flush();
    await flow.resolve('bad');
    expect(ofType(events, 'resolve-error').at(-1)?.message).toBe('cannot resolve identifier');
    expect(flow.resolvedSp).toBeNull();

    // Case 2: fast burned B (direct tsp1) while slow A is in flight again
    void flow.resolve('npubA');
    await flush();
    await flow.resolve(BURNED_TSP1[0]);
    const applied = ofType(events, 'resolve-applied');
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ resolvedSp: null });

    // A completes late — must not resurrect a usable recipient
    slow.res(bindingFor(SP_A, 'pk-npubA'));
    await flush();
    expect(flow.resolvedSp).toBeNull();
    expect(ofType(events, 'resolve-applied')).toHaveLength(1);
  });

  it('a stale resolve error does not clobber a newer success', async () => {
    const slowA = deferred<ResolvedBinding | null>();
    const { flow, events } = harness({
      fetchBinding: vi.fn((pk: string) =>
        pk === 'pk-npubA' ? slowA.p : Promise.resolve(bindingFor(SP_B, pk))),
    });
    const pa = flow.resolve('npubA');
    await flush();                      // A is now suspended awaiting fetchBinding
    await flow.resolve('npubB');        // B wins; A is stale but still suspended
    expect(flow.resolvedSp).toBe(SP_B);

    slowA.rej(new Error('relay timeout')); // late error must be dropped, not shown
    await pa;
    await flush();
    expect(flow.resolvedSp).toBe(SP_B);
    expect(ofType(events, 'resolve-error')).toHaveLength(0);
  });

  it('same-input supersession: a stale same-input failure cannot clear the newer pending marker', async () => {
    const a1 = deferred<ResolvedBinding | null>();
    const a2 = deferred<ResolvedBinding | null>();
    let calls = 0;
    const { flow, events } = harness({
      fetchBinding: vi.fn(() => (++calls === 1 ? a1.p : a2.p)),
    });
    const p1 = flow.resolve('npubA');
    await flush();                      // A1 suspended awaiting fetchBinding
    const p2 = flow.resolve('npubA');   // same raw input — A2 supersedes A1
    await flush();                      // A2 suspended awaiting its own fetchBinding
    a1.rej(new Error('old request failed'));
    await p1;                           // stale reject must NOT clear A2's pending marker
    expect(ofType(events, 'resolve-error')).toHaveLength(0);

    flow.recipientEdited('npubB');      // pending still owned by A2 → edit invalidates it
    expect(ofType(events, 'resolve-cleared').at(-1)?.reason).toBe('edited');
    a2.res(bindingFor(SP_A, 'pk-npubA'));
    await p2;
    await flush();
    expect(flow.resolvedSp).toBeNull();
    expect(ofType(events, 'resolve-applied')).toHaveLength(0);
  });

  it('a burned verified binding applies but yields no usable recipient', async () => {
    const { flow, events } = harness({
      fetchBinding: vi.fn(async () => bindingFor(BURNED_TSP1[0], 'pk-x')),
    });
    await flow.resolve('npubX');
    expect(flow.resolvedSp).toBeNull();
    const applied = ofType(events, 'resolve-applied');
    expect(applied[0]).toMatchObject({ resolvedSp: null });
    expect(applied[0].binding).toMatchObject({ burned: true, kind: 'verified' });
  });
});

describe('TipFlow send', () => {
  it('uses the snapshot taken before fee fetch, not live state', async () => {
    const fees = deferred<Record<string, number>>();
    const { flow, deps, sent } = harness({ getFeeEstimates: vi.fn(() => fees.p) });
    flow.setWallet(WALLET_A);
    await flow.refreshUtxos();
    await flow.resolve('npubA');
    expect(flow.resolvedSp).toBe(SP_A);

    const sendP = flow.send({ sats: 1000, staticTip: false });
    // user edits everything mid-flight: different recipient + different wallet
    flow.recipientEdited('npubB');
    await flow.resolve('npubB');
    flow.setWallet(WALLET_B);
    await flow.refreshUtxos();

    fees.res({ '6': 2 });
    await sendP;

    expect(deps.buildSilentTipTx).toHaveBeenCalledWith(
      expect.objectContaining({ spAddress: SP_A, wallet: WALLET_A, utxos: [UTXO_A] }),
    );
    expect(sent[0]).toMatchObject({ kind: 'silent', to: SP_A });
    expect(deps.broadcastTx).toHaveBeenCalledWith(`hex-for-${SP_A.slice(0, 12)}`);
  });

  it('ignores a concurrent send while one is in flight', async () => {
    const bc = deferred<string>();
    const { flow, deps, events } = harness({ broadcastTx: vi.fn(() => bc.p) });
    flow.setWallet(WALLET_A);
    await flow.refreshUtxos();
    await flow.resolve('npubA');

    const p1 = flow.send({ sats: 1000, staticTip: false });
    const p2 = flow.send({ sats: 1000, staticTip: false });
    await flush();
    bc.res('txid-' + '9'.repeat(58));
    await Promise.all([p1, p2]);

    expect(deps.broadcastTx).toHaveBeenCalledTimes(1);
    expect(ofType(events, 'sent-silent')).toHaveLength(1);
  });

  it('keeps broadcast success visible when the follow-up refresh fails', async () => {
    let calls = 0;
    const { flow, deps, events, sent } = harness({
      getAddressUtxos: vi.fn(async () => (++calls === 1 ? [UTXO_A] : Promise.reject(new Error('esplora down')))),
    });
    flow.setWallet(WALLET_A);
    await flow.refreshUtxos();               // call 1: seeds UTXOs
    await flow.resolve('npubA');

    await flow.send({ sats: 1000, staticTip: false }); // post-send refresh rejects
    expect(ofType(events, 'sent-silent')).toHaveLength(1);
    expect(ofType(events, 'send-error')).toHaveLength(0);
    expect(ofType(events, 'utxos-error').at(-1)?.message).toBe('esplora down');
    expect(sent).toHaveLength(1);

    // the spent cached set is invalidated — a follow-up send cannot reuse it
    expect(flow.utxoList).toHaveLength(0);
    await flow.send({ sats: 1000, staticTip: false });
    expect(deps.broadcastTx).toHaveBeenCalledTimes(1);
    expect(ofType(events, 'send-error').at(-1)?.message).toBe('No UTXOs — fund the sender address first');
  });

  it('recovers after a broadcast failure — the next send works', async () => {
    const bc = vi.fn()
      .mockRejectedValueOnce(new Error('broadcast rejected'))
      .mockResolvedValueOnce('txid-' + '8'.repeat(58));
    const { flow, events, sent } = harness({ broadcastTx: bc });
    flow.setWallet(WALLET_A);
    await flow.refreshUtxos();
    await flow.resolve('npubA');

    await flow.send({ sats: 1000, staticTip: false });
    expect(flow.sending).toBe(false);
    expect(ofType(events, 'send-error').at(-1)?.message).toBe('broadcast rejected');

    await flow.send({ sats: 1000, staticTip: false });
    expect(bc).toHaveBeenCalledTimes(2);
    expect(ofType(events, 'sent-silent')).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('static tip also uses the immutable snapshot', async () => {
    const fees = deferred<Record<string, number>>();
    const { flow, deps, sent } = harness({ getFeeEstimates: vi.fn(() => fees.p) });
    flow.setWallet(WALLET_A);
    await flow.refreshUtxos();

    const p = flow.send({ sats: 1000, staticTip: true });
    flow.setWallet(WALLET_B);                 // swap mid-flight
    await flow.refreshUtxos();
    fees.res({ '6': 3 });
    await p;

    expect(deps.buildStaticTipTx).toHaveBeenCalledWith(WALLET_A, [UTXO_A], 1000, 3);
    expect(sent[0]).toMatchObject({ kind: 'static', to: WALLET_A.address });
  });
});

describe('TipFlow wallet refresh', () => {
  it('clears UTXOs immediately on wallet replacement and drops stale fetches', async () => {
    const slowA = deferred<EsploraUtxo[]>();
    const { flow, events } = harness({
      getAddressUtxos: vi.fn((addr: string) =>
        addr === WALLET_A.address ? slowA.p : Promise.resolve([UTXO_B])),
    });
    flow.setWallet(WALLET_A);
    void flow.refreshUtxos();
    await flush();

    flow.setWallet(WALLET_B);
    expect(flow.utxoList).toHaveLength(0);   // cleared immediately
    await flow.refreshUtxos();
    expect(flow.utxoList).toEqual([UTXO_B]);

    slowA.res([UTXO_A]);                     // stale A result arrives late
    await flush();
    expect(flow.utxoList).toEqual([UTXO_B]);
    const applied = ofType(events, 'utxos-applied');
    expect(applied).toHaveLength(1);
    expect(applied[0].address).toBe(WALLET_B.address);
  });

  it('drops a stale utxos-error from a superseded wallet', async () => {
    const slowA = deferred<EsploraUtxo[]>();
    const { flow, events } = harness({
      getAddressUtxos: vi.fn((addr: string) =>
        addr === WALLET_A.address ? slowA.p : Promise.resolve([UTXO_B])),
    });
    flow.setWallet(WALLET_A);
    void flow.refreshUtxos();
    await flush();
    flow.setWallet(WALLET_B);
    await flow.refreshUtxos();
    slowA.rej(new Error('stale failure'));
    await flush();
    expect(ofType(events, 'utxos-error')).toHaveLength(0);
  });
});
