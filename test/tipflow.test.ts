import { describe, it, expect, vi } from 'vitest';
import { TipFlow, TipFlowHost, type TipDeps, type TipEvent } from '../src/ui/tipFlow';
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
const UTXO_C: EsploraUtxo = { txid: 'c'.repeat(64), vout: 0, value: 7_000, status: { confirmed: true } };

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

function harness(overrides: Partial<TipDeps> = {}, onEmit?: (e: TipEvent) => void): Harness {
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
    buildStaticTipTx: vi.fn(() => ({ txHex: 'static-hex', spent: [UTXO_A] })),
    onSentTip: (t: StoredTip) => sent.push(t),
    relays: ['wss://relay.example'],
    ...overrides,
  };
  // onEmit simulates a faulting renderer: it runs inside the emitter call and
  // may throw — the flow must swallow that (notify) without corrupting state.
  return { deps, events, sent, flow: new TipFlow(deps, (e) => { events.push(e); onEmit?.(e); }) };
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

  it.each(['QuotaExceededError', 'SecurityError'])(
    'a %s persistence failure keeps the accepted broadcast as success',
    async (errName) => {
      let calls = 0;
      const { flow, deps, events, sent } = harness({
        onSentTip: () => { throw new Error(errName); },
        getAddressUtxos: vi.fn(async () =>
          (++calls === 1 ? [UTXO_A] : Promise.reject(new Error('esplora down')))),
      });
      flow.setWallet(WALLET_A);
      await flow.refreshUtxos();
      await flow.resolve('npubA');

      await flow.send({ sats: 1000, staticTip: false });
      // broadcast accepted → reported as success carrying a storage warning
      const sentEvents = ofType(events, 'sent-silent');
      expect(sentEvents).toHaveLength(1);
      expect(sentEvents[0].storageError).toBe(errName);
      expect(ofType(events, 'send-error')).toHaveLength(0);
      expect(sent).toHaveLength(0);            // nothing persisted
      // lock released for the next operation
      expect(flow.sending).toBe(false);
      expect(ofType(events, 'send-busy').at(-1)?.busy).toBe(false);
      // spent inputs invalidated even though persistence threw — no reuse
      expect(flow.utxoList).toHaveLength(0);
      await flow.send({ sats: 1000, staticTip: false });
      expect(deps.broadcastTx).toHaveBeenCalledTimes(1);
      expect(ofType(events, 'send-error').at(-1)?.message)
        .toBe('No UTXOs — fund the sender address first');
    },
  );

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

describe('TipFlow remount (TipFlowHost)', () => {
  it('a second mount shares the in-flight send — navigation cannot double-tip', async () => {
    // Faithful equivalent of main.ts show(tab): the panel is re-rendered and
    // a new renderer mounts while the previous mount's send is still pending.
    const fees = deferred<Record<string, number>>();
    const { deps, events: evA } = harness({ getFeeEstimates: vi.fn(() => fees.p) });
    const host = new TipFlowHost(deps);
    const f1 = host.mount((e) => evA.push(e));

    f1.setWallet(WALLET_A);
    await f1.refreshUtxos();
    await f1.resolve('npubA');
    const sendP = f1.send({ sats: 1000, staticTip: false }); // pending on fees

    // navigate away and back: remount re-targets events, keeps one flow
    const evB: TipEvent[] = [];
    const f2 = host.mount((e) => evB.push(e));
    expect(f2).toBe(f1);
    expect(f2.sending).toBe(true);             // in-flight survives the mount
    // restore data keeps the fresh input consistent with the resolution
    expect(f2.boundInputText).toBe('npubA');
    expect(f2.bindingView).toMatchObject({ kind: 'verified', sp: SP_A });

    await f2.send({ sats: 1000, staticTip: false }); // second click on new mount
    fees.res({ '6': 2 });
    await sendP;
    await flush();
    expect(deps.broadcastTx).toHaveBeenCalledTimes(1);
    // completion delivered to the CURRENT renderer, not the dead one
    expect(ofType(evB, 'sent-silent')).toHaveLength(1);
    expect(ofType(evA, 'sent-silent')).toHaveLength(0);
    expect(f2.lastSendOutcome?.type).toBe('sent-silent');
  });

  it('a mount after a completed send replays the last outcome', async () => {
    const { deps, events: evA } = harness();
    const host = new TipFlowHost(deps);
    const f1 = host.mount((e) => evA.push(e));
    f1.setWallet(WALLET_A);
    await f1.refreshUtxos();
    await f1.resolve('npubA');
    await f1.send({ sats: 1000, staticTip: false });
    expect(f1.lastSendOutcome?.type).toBe('sent-silent');

    const evB: TipEvent[] = [];
    const f2 = host.mount((e) => evB.push(e));
    // fresh DOM can replay the exact last outcome event
    if (f2.lastSendOutcome) evB.push(f2.lastSendOutcome);
    expect(ofType(evB, 'sent-silent')).toHaveLength(1);
    expect(f2.walletAddress).toBe(WALLET_A.address);
  });
});

describe('renderer (emitter) faults', () => {
  it.each(['silent', 'static'] as const)(
    'a throwing sent-%s emitter preserves the accepted success and still refreshes',
    async (kind) => {
      let utxoCalls = 0;
      const { flow, deps, events } = harness(
        {
          getAddressUtxos: vi.fn(async () => (++utxoCalls === 1 ? [UTXO_A] : [UTXO_C])),
        },
        (e) => {
          if (e.type === 'sent-static' || e.type === 'sent-silent')
            throw new Error('render crashed');
        },
      );
      flow.setWallet(WALLET_A);
      await flow.refreshUtxos();
      await flow.resolve('npubA');
      await flow.send({ sats: 1000, staticTip: kind === 'static' });

      expect(deps.broadcastTx).toHaveBeenCalledTimes(1);
      expect(ofType(events, 'send-error')).toHaveLength(0); // never mislabeled
      expect(flow.sending).toBe(false);                     // lock released
      expect(utxoCalls).toBe(2);                            // post-send refresh ran
      expect(flow.utxoList).toEqual([UTXO_C]);
      // outcome stays accurate → replayable on a healthy remount
      const sentType = kind === 'static' ? 'sent-static' : 'sent-silent';
      expect(flow.lastSendOutcome?.type).toBe(sentType);
      const evB: TipEvent[] = [];
      flow.setEmitter((e) => evB.push(e));
      if (flow.lastSendOutcome) evB.push(flow.lastSendOutcome);
      expect(ofType(evB, sentType)).toHaveLength(1);
    },
  );

  it('a throwing busy-release emitter still releases the lock', async () => {
    let utxoCalls = 0;
    const { flow, deps, events } = harness(
      {
        getAddressUtxos: vi.fn(async () => (++utxoCalls === 1 ? [UTXO_A] : [UTXO_C])),
      },
      (e) => {
        if (e.type === 'send-busy' && !e.busy) throw new Error('render crashed');
      },
    );
    flow.setWallet(WALLET_A);
    await flow.refreshUtxos();
    await flow.resolve('npubA');
    await flow.send({ sats: 1000, staticTip: false });      // must resolve, not reject

    expect(flow.sending).toBe(false);
    expect(flow.lastSendOutcome?.type).toBe('sent-silent');
    expect(ofType(events, 'send-error')).toHaveLength(0);
    // lock truly released — a follow-up send on fresh inputs runs
    await flow.send({ sats: 600, staticTip: false });
    expect(deps.broadcastTx).toHaveBeenCalledTimes(2);
  });

  it('a throwing success emitter plus storage failure still reports accepted success', async () => {
    const { flow, events } = harness(
      {
        onSentTip: () => { throw new Error('QuotaExceededError'); },
        getAddressUtxos: vi.fn(async () => [UTXO_A]),  // spent echo on refresh
      },
      (e) => {
        if (e.type === 'sent-silent') throw new Error('render crashed');
      },
    );
    flow.setWallet(WALLET_A);
    await flow.refreshUtxos();
    await flow.resolve('npubA');
    await flow.send({ sats: 1000, staticTip: false });

    const sent = ofType(events, 'sent-silent');
    expect(sent).toHaveLength(1);
    expect(sent[0].storageError).toBe('QuotaExceededError');
    expect(ofType(events, 'send-error')).toHaveLength(0);
    expect(flow.lastSendOutcome?.type).toBe('sent-silent');
    expect(flow.utxoList).toHaveLength(0);                  // spent echo filtered
  });
});

describe('saved-WIF remount (same-address wallet object)', () => {
  it('same-address restore is a no-op and preserves a pending refresh', async () => {
    const slow = deferred<EsploraUtxo[]>();
    const { flow, events } = harness({ getAddressUtxos: vi.fn(() => slow.p) });
    flow.setWallet(WALLET_A);
    void flow.refreshUtxos();
    await flush();

    // renderTip's saved-WIF block rebuilds a fresh wallet object on remount
    flow.setWallet({ ...WALLET_A });
    slow.res([UTXO_A]);
    await flush();

    expect(flow.utxoList).toEqual([UTXO_A]);   // pending refresh still applied
    expect(ofType(events, 'wallet-changed')).toHaveLength(1); // no redundant emit
  });

  it.each(['before', 'after'] as const)(
    'same-address restore during an in-flight send keeps invalidation (refresh resolves %s acceptance)',
    async (when) => {
      const bc = deferred<string>();
      const ref = deferred<EsploraUtxo[]>();
      let calls = 0;
      const { flow, deps, events } = harness({
        broadcastTx: vi.fn(() => bc.p),
        // indexer delay: the spent input keeps coming back on later refreshes
        getAddressUtxos: vi.fn(() => (++calls === 1 ? Promise.resolve([UTXO_A]) : ref.p)),
      });
      flow.setWallet(WALLET_A);
      await flow.refreshUtxos();               // seeds [UTXO_A]
      await flow.resolve('npubA');

      const sendP = flow.send({ sats: 1000, staticTip: false }); // awaiting broadcast
      await flush();

      // remount: same-address WIF restore + its refresh call (as renderTip does)
      flow.setWallet({ ...WALLET_A });
      const remountRefresh = flow.refreshUtxos();
      if (when === 'before') {
        ref.res([UTXO_A]);                     // indexer echo before acceptance
        await remountRefresh;
      }

      bc.res('txid-' + '9'.repeat(58));        // broadcast accepted
      if (when === 'after') {
        // the remount refresh AND the post-send refresh share this deferred —
        // resolve it now (spent echo); the remount one is superseded and dropped
        ref.res([UTXO_A]);
      }
      await Promise.all([sendP, remountRefresh]);
      await flush();

      expect(ofType(events, 'sent-silent')).toHaveLength(1);
      expect(ofType(events, 'send-error')).toHaveLength(0);
      // the spent outpoint is excluded no matter when the refresh landed
      expect(flow.utxoList).toHaveLength(0);
      await flow.send({ sats: 1000, staticTip: false });
      expect(deps.broadcastTx).toHaveBeenCalledTimes(1);
      expect(ofType(events, 'send-error').at(-1)?.message)
        .toBe('No UTXOs — fund the sender address first');
    },
  );

  it('post-broadcast indexer delay: spent inputs are excluded, genuinely new UTXOs preserved', async () => {
    let calls = 0;
    const { flow, deps, events } = harness({
      getAddressUtxos: vi.fn(async () =>
        (++calls === 1 ? [UTXO_A] : [UTXO_A, UTXO_C])), // lagging index echoes the spent input
    });
    flow.setWallet(WALLET_A);
    await flow.refreshUtxos();
    await flow.resolve('npubA');

    await flow.send({ sats: 1000, staticTip: false });
    expect(ofType(events, 'sent-silent')).toHaveLength(1);
    expect(flow.utxoList).toEqual([UTXO_C]);   // spent A excluded, new C kept

    // a follow-up send builds ONLY from genuinely unspent inputs
    await flow.send({ sats: 600, staticTip: false });
    expect(deps.buildSilentTipTx).toHaveBeenLastCalledWith(
      expect.objectContaining({ utxos: [UTXO_C] }),
    );
    expect(deps.broadcastTx).toHaveBeenCalledTimes(2);
  });

  it('static-tip persistence failure keeps success and excludes spent inputs', async () => {
    let calls = 0;
    const { flow, deps, events } = harness({
      onSentTip: () => { throw new Error('QuotaExceededError'); },
      getAddressUtxos: vi.fn(async () =>
        (++calls === 1 ? [UTXO_A] : [UTXO_A])), // lagging echo of the spent input
    });
    flow.setWallet(WALLET_A);
    await flow.refreshUtxos();

    await flow.send({ sats: 1000, staticTip: true });
    const sent = ofType(events, 'sent-static');
    expect(sent).toHaveLength(1);
    expect(sent[0].storageError).toBe('QuotaExceededError');
    expect(ofType(events, 'send-error')).toHaveLength(0);
    expect(flow.utxoList).toHaveLength(0);     // spent echo filtered out

    // no retry, no rebuild on spent inputs
    await flow.send({ sats: 1000, staticTip: true });
    expect(deps.broadcastTx).toHaveBeenCalledTimes(1);
    expect(ofType(events, 'send-error').at(-1)?.message)
      .toBe('No UTXOs — fund the sender address first');
  });
});

describe('A→B→A same-address wallet object swap', () => {
  it('spent inputs cannot be reused after a mid-send swap', async () => {
    const bc = deferred<string>();
    const { flow, deps, events } = harness({
      broadcastTx: vi.fn(() => bc.p),
      // indexer keeps echoing the soon-spent input for A's address
      getAddressUtxos: vi.fn(async (addr: string) =>
        addr === WALLET_B.address ? [UTXO_B] : [UTXO_A]),
    });
    flow.setWallet(WALLET_A);
    await flow.refreshUtxos();
    await flow.resolve('npubA');
    const sendP = flow.send({ sats: 1000, staticTip: false }); // pending broadcast
    await flush();

    flow.setWallet(WALLET_B);                        // swap away mid-flight
    await flow.refreshUtxos();
    flow.setWallet({ ...WALLET_A });                 // back to A — new object
    await flow.refreshUtxos();                       // echoes spent-soon input
    expect(flow.utxoList).toEqual([UTXO_A]);

    bc.res('txid-' + '9'.repeat(58));
    await sendP;
    await flush();

    expect(ofType(events, 'sent-silent')).toHaveLength(1);
    expect(flow.utxoList).toHaveLength(0);           // unconditional spent filter
    await flow.send({ sats: 1000, staticTip: false });
    expect(deps.broadcastTx).toHaveBeenCalledTimes(1); // no retry on spent inputs
    expect(ofType(events, 'send-error').at(-1)?.message)
      .toBe('No UTXOs — fund the sender address first');
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
