import type { EsploraUtxo } from '../chain/esplora';
import type { ResolvedBinding } from '../nostr/binding';
import type { SendPlan, SenderWallet } from '../sp/send';
import type { StoredTip } from '../state';

/**
 * DOM-free controller for the Tip tab. All async work (binding resolution,
 * UTXO fetches, the broadcast flow) is sequenced here so the UI layer can be
 * a pure renderer of emitted events. Two invariants it enforces:
 *
 * - A resolution is bound to the exact input text it was produced from. Any
 *   edit or newer request invalidates it; stale async completions/errors are
 *   dropped, so an out-of-order finish can never resurrect or overwrite the
 *   current resolution.
 * - A send operates on an immutable snapshot (recipient/mode/amount/wallet/
 *   UTXOs) taken before the first await, with at most one send in flight.
 */

export interface TipDeps {
  resolveIdentifier(input: string): Promise<string>;
  fetchBinding(pubkey: string, relays: string[]): Promise<ResolvedBinding | null>;
  isSignetSpAddress(input: string): boolean;
  isBurnedSp(sp: string): boolean;
  getAddressUtxos(address: string): Promise<EsploraUtxo[]>;
  getFeeEstimates(): Promise<Record<string, number>>;
  broadcastTx(txHex: string): Promise<string>;
  buildSilentTipTx(params: {
    wallet: SenderWallet;
    utxos: EsploraUtxo[];
    spAddress: string;
    amountSats: number;
    feeRateSatVb: number;
  }): SendPlan;
  buildStaticTipTx(
    wallet: SenderWallet,
    utxos: EsploraUtxo[],
    amountSats: number,
    feeRateSatVb: number,
  ): { txHex: string; spent: EsploraUtxo[] };
  onSentTip(tip: StoredTip): void;
  relays: string[];
}

export type BindingView =
  | { kind: 'direct'; sp: string; burned: boolean }
  | {
      kind: 'verified';
      sp: string;
      burned: boolean;
      pubkey: string;
      eventId: string;
      eventKind: number;
      createdAt: number;
    };

export type TipEvent =
  | { type: 'resolve-cleared'; reason: 'edited' | 'new-resolve' }
  | { type: 'resolve-progress'; input: string; message: string }
  | { type: 'resolve-applied'; input: string; binding: BindingView; resolvedSp: string | null }
  | { type: 'resolve-error'; input: string; message: string }
  | { type: 'wallet-changed'; address: string | null }
  | { type: 'utxos-pending'; address: string }
  | { type: 'utxos-applied'; address: string; utxos: EsploraUtxo[] }
  | { type: 'utxos-error'; address: string; message: string }
  | { type: 'send-busy'; busy: boolean }
  | { type: 'send-error'; message: string }
  | { type: 'sent-static'; txid: string; to: string; amountSats: number; storageError?: string }
  | {
      type: 'sent-silent';
      txid: string;
      to: string;
      amountSats: number;
      fee: number;
      inputCount: number;
      silentOutputIndexes: number[];
      storageError?: string;
    };

interface Resolution {
  sp: string;
  /** The exact input text this resolution was produced from. */
  input: string;
  verified: boolean;
}

export class TipFlow {
  private resolveSeq = 0;
  private refreshSeq = 0;
  private walletGen = 0;
  private resolution: Resolution | null = null;
  private pendingResolve: { seq: number; input: string } | null = null;
  private wallet: SenderWallet | null = null;
  private utxos: EsploraUtxo[] = [];
  private inFlight = false;
  private lastApplied: BindingView | null = null;
  private lastOutcome: TipEvent | null = null;
  /** Outpoints spent by accepted broadcasts this session — never un-spent,
   *  so refresh results filtered through them can't repopulate spent inputs. */
  private readonly spentOutpoints = new Set<string>();

  constructor(
    private readonly deps: TipDeps,
    private emit: (evt: TipEvent) => void,
  ) {}

  /**
   * Re-target event delivery after a UI remount. The controller outlives the
   * DOM (it is session-scoped via TipFlowHost), so a fresh renderer is attached
   * on every mount.
   */
  setEmitter(emit: (evt: TipEvent) => void): void {
    this.emit = emit;
  }

  /**
   * Deliver an event to the current renderer. A faulting renderer must never
   * corrupt flow state — its error is swallowed here, so e.g. a crash while
   * rendering a broadcast success can no longer masquerade as a send failure,
   * skip the post-send refresh, or corrupt lastSendOutcome (which stays
   * accurate for replay on a healthy remount).
   */
  private notify(evt: TipEvent): void {
    try {
      this.emit(evt);
    } catch { /* renderer fault — state stays authoritative */ }
  }

  /** Current validated recipient, or null when none/dirty/burned. */
  get resolvedSp(): string | null {
    return this.resolution?.sp ?? null;
  }

  get isResolved(): boolean {
    return this.resolution !== null;
  }

  get sending(): boolean {
    return this.inFlight;
  }

  get walletAddress(): string | null {
    return this.wallet?.address ?? null;
  }

  get utxoList(): readonly EsploraUtxo[] {
    return this.utxos;
  }

  /** The input text bound to the current resolution or in-flight resolve —
   *  for restoring the recipient field on remount so it can't diverge from
   *  the resolution invisibly. */
  get boundInputText(): string | null {
    return this.pendingResolve?.input ?? this.resolution?.input ?? null;
  }

  /** Last applied binding view (for re-rendering on remount). */
  get bindingView(): BindingView | null {
    return this.lastApplied;
  }

  /** Most recent sent or send-error event (for re-rendering on remount). */
  get lastSendOutcome(): TipEvent | null {
    return this.lastOutcome;
  }

  /**
   * Called on every recipient-field edit. Editing away from the bound input
   * drops the current resolution and cancels any in-flight resolve, so a
   * stale async completion can never repopulate an edited field.
   */
  recipientEdited(raw: string): void {
    const input = raw.trim();
    if (this.pendingResolve !== null && input !== this.pendingResolve.input) {
      this.resolveSeq++;
      this.pendingResolve = null;
      this.notify({ type: 'resolve-cleared', reason: 'edited' });
      return;
    }
    if (this.resolution && input !== this.resolution.input) {
      this.resolveSeq++;
      this.resolution = null;
      this.lastApplied = null;
      this.notify({ type: 'resolve-cleared', reason: 'edited' });
    }
  }

  /** Resolve the current input; later calls and edits supersede earlier ones. */
  async resolve(rawInput: string): Promise<void> {
    const input = rawInput.trim();
    const seq = ++this.resolveSeq;
    this.pendingResolve = { seq, input };
    this.resolution = null;
    this.lastApplied = null;
    this.notify({ type: 'resolve-cleared', reason: 'new-resolve' });
    const stale = () => seq !== this.resolveSeq;
    // Only the request that owns the pending slot may clear it — a stale
    // request finishing (success or error) must never drop a newer one's
    // pending marker, or an input edit could fail to invalidate it.
    const done = () => {
      if (this.pendingResolve?.seq === seq) this.pendingResolve = null;
    };
    try {
      if (!input) throw new Error('Enter an npub, NIP-05, or tsp1 address');
      if (this.deps.isSignetSpAddress(input)) {
        done();
        const burned = this.deps.isBurnedSp(input);
        this.resolution = burned ? null : { sp: input, input, verified: false };
        const binding: BindingView = { kind: 'direct', sp: input, burned };
        this.lastApplied = binding;
        this.notify({
          type: 'resolve-applied',
          input,
          binding,
          resolvedSp: this.resolvedSp,
        });
        return;
      }
      const pubkey = await this.deps.resolveIdentifier(input);
      if (stale()) return;
      this.notify({ type: 'resolve-progress', input, message: 'Resolving binding from relays…' });
      const res = await this.deps.fetchBinding(pubkey, this.deps.relays);
      if (stale()) return;
      done();
      if (!res) throw new Error('No silenttip binding event found for this pubkey');
      if (!res.signatureValid)
        throw new Error('Binding event signature INVALID — not showing address');
      if (res.binding.network !== 'signet')
        throw new Error(`Binding is for "${res.binding.network}", this demo is signet-only`);
      const burned = this.deps.isBurnedSp(res.binding.sp);
      this.resolution = burned ? null : { sp: res.binding.sp, input, verified: true };
      const binding: BindingView = {
        kind: 'verified',
        sp: res.binding.sp,
        burned,
        pubkey,
        eventId: res.event.id,
        eventKind: res.event.kind,
        createdAt: res.event.created_at,
      };
      this.lastApplied = binding;
      this.notify({
        type: 'resolve-applied',
        input,
        binding,
        resolvedSp: this.resolvedSp,
      });
    } catch (e) {
      if (stale()) return;
      done();
      this.notify({ type: 'resolve-error', input, message: (e as Error).message });
    }
  }

  /**
   * Replace the sender wallet; drops old UTXOs and cancels in-flight fetches.
   * Wallet identity is the ADDRESS: a same-address object (e.g. a WIF
   * re-import on tab remount) is a no-op, preserving pending refreshes and
   * the identity that in-flight sends compare against.
   */
  setWallet(wallet: SenderWallet | null): void {
    if (this.wallet?.address === wallet?.address) return;
    this.wallet = wallet;
    this.walletGen++;
    this.refreshSeq++;
    this.utxos = [];
    this.notify({ type: 'wallet-changed', address: wallet?.address ?? null });
  }

  /** Fetch UTXOs for the current wallet; results apply only while it stays current. */
  async refreshUtxos(): Promise<void> {
    const wallet = this.wallet;
    if (!wallet) return;
    const gen = this.walletGen;
    const seq = ++this.refreshSeq;
    this.notify({ type: 'utxos-pending', address: wallet.address });
    try {
      const fetched = await this.deps.getAddressUtxos(wallet.address);
      if (gen !== this.walletGen || seq !== this.refreshSeq) return;
      // Indexer lag can echo back inputs a broadcast just spent — they are
      // outpoints, they can never un-spend, so filter them for the session.
      const utxos = fetched.filter((u) => !this.spentOutpoints.has(`${u.txid}:${u.vout}`));
      this.utxos = utxos;
      this.notify({ type: 'utxos-applied', address: wallet.address, utxos });
    } catch (e) {
      if (gen !== this.walletGen || seq !== this.refreshSeq) return;
      this.notify({ type: 'utxos-error', address: wallet.address, message: (e as Error).message });
    }
  }

  /**
   * Build and broadcast a tip. Everything the operation touches is snapshotted
   * before the first await, so edits during fee fetching cannot redirect the
   * payment, and a second click while in flight is a no-op.
   */
  async send(opts: { sats: number; staticTip: boolean }): Promise<void> {
    if (this.inFlight) return;
    const { sats, staticTip } = opts;
    const wallet = this.wallet;
    const utxos = this.utxos.slice();
    const resolution = this.resolution;

    const outcome = (evt: TipEvent) => {
      this.lastOutcome = evt;
      this.notify(evt);
    };
    const fail = (message: string) => outcome({ type: 'send-error', message });
    if (!Number.isFinite(sats) || sats < 546) return fail('Amount must be ≥ 546 sats');
    if (!wallet) return fail('Set up the sender wallet first');
    if (!utxos.length) return fail('No UTXOs — fund the sender address first');
    const spAddress = staticTip ? wallet.address : resolution?.sp;
    if (!staticTip && !spAddress) return fail('Resolve a recipient first');

    this.inFlight = true;
    this.lastOutcome = null;
    this.notify({ type: 'send-busy', busy: true });
    try {
      const fees = await this.deps.getFeeEstimates();
      const rate = Math.max(1, Math.ceil(fees['6'] ?? 1));
      let txHex: string;
      let kind: StoredTip['kind'];
      let to: string;
      let plan: SendPlan | null = null;
      let spentInputs: EsploraUtxo[];
      if (staticTip) {
        const built = this.deps.buildStaticTipTx(wallet, utxos, sats, rate);
        txHex = built.txHex;
        spentInputs = built.spent;
        kind = 'static';
        to = wallet.address;
      } else {
        if (spAddress === undefined) throw new Error('Resolve a recipient first');
        plan = this.deps.buildSilentTipTx({
          wallet,
          utxos,
          spAddress,
          amountSats: sats,
          feeRateSatVb: rate,
        });
        txHex = plan.txHex;
        spentInputs = plan.inputs;
        kind = 'silent';
        to = spAddress;
      }
      const txid = await this.deps.broadcastTx(txHex);
      // Mark the consumed outpoints spent for the rest of the session — a
      // lagging indexer's refresh can then never repopulate them. Also drop
      // the cached set immediately, BEFORE persistence, which is best-effort
      // and may throw (e.g. localStorage QuotaExceededError) — a failure must
      // not leave a stale spendable set behind.
      for (const u of spentInputs) this.spentOutpoints.add(`${u.txid}:${u.vout}`);
      // Drop spent inputs from the live cache unconditionally — the current
      // wallet may be a fresh object for the same address (A→B→A re-import),
      // so object identity is not a reliable gate here.
      this.utxos = this.utxos.filter((u) => !this.spentOutpoints.has(`${u.txid}:${u.vout}`));
      let storageError: string | undefined;
      try {
        this.deps.onSentTip({ txid, kind, amountSats: sats, to, at: Date.now() });
      } catch (e) {
        // The broadcast already succeeded — a persistence failure is a
        // warning on the success, never a send failure.
        storageError = (e as Error).message;
      }
      if (plan) {
        outcome({
          type: 'sent-silent',
          txid,
          to,
          amountSats: sats,
          fee: plan.fee,
          inputCount: plan.inputs.length,
          silentOutputIndexes: plan.silentOutputIndexes,
          storageError,
        });
      } else {
        outcome({ type: 'sent-static', txid, to, amountSats: sats, storageError });
      }
      // Post-broadcast balance refresh is best-effort: its failure must not
      // mask a successful send, so it reports through utxos-error only. The
      // cache was already filtered for spent inputs; if the current wallet is
      // still the SAME ADDRESS (object identity may differ after re-import),
      // refresh it — filtered through spentOutpoints so indexer-delayed echoes
      // of spent inputs cannot repopulate.
      if (this.wallet?.address === wallet.address) await this.refreshUtxos();
    } catch (e) {
      outcome({ type: 'send-error', message: (e as Error).message });
    } finally {
      this.inFlight = false;
      this.notify({ type: 'send-busy', busy: false });
    }
  }
}

/**
 * Session-scoped owner of the TipFlow. The Tip tab re-renders on every
 * navigation (main.ts `show()` clears content and calls renderTip), and a
 * fresh controller would lose `inFlight`, letting a second send run
 * concurrently. The host keeps one flow for the page session and re-targets
 * its emitter to the newest renderer on each mount; the mount then replays
 * the flow's public state (boundInputText, bindingView, sending,
 * lastSendOutcome) into the fresh DOM.
 */
export class TipFlowHost {
  private flow: TipFlow | null = null;

  constructor(private readonly deps: TipDeps) {}

  mount(renderer: (evt: TipEvent) => void): TipFlow {
    if (!this.flow) {
      this.flow = new TipFlow(this.deps, renderer);
    } else {
      this.flow.setEmitter(renderer);
    }
    return this.flow;
  }
}
