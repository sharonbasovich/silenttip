import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  SimplePool,
  verifyEvent,
  type Event,
  type EventTemplate,
} from 'nostr-tools';

/**
 * The binding is a NIP-78 parameterized-replaceable event (kind 30078)
 * with d-tag "silenttip". Content is JSON: {v, sp, network}.
 *
 * The npub only *signs a binding* to the tsp1 address — SP keys are derived
 * from an independent seed, so a leaked scan key can never touch the Nostr
 * identity and a compromised nsec can't spend funds (unlike the NIP draft
 * that derives sp1 directly from nsec).
 */
export const BINDING_KIND = 30078;
export const BINDING_D_TAG = 'silenttip';

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

export interface SilentTipBinding {
  v: number;
  sp: string;
  network: 'signet';
}

export interface PublishResult {
  relay: string;
  ok: boolean;
  error?: string;
}

export interface ResolvedBinding {
  event: Event;
  binding: SilentTipBinding;
  pubkey: string;
  signatureValid: boolean;
  relayHint?: string;
}

let pool: SimplePool | null = null;
function getPool(): SimplePool {
  pool ??= new SimplePool();
  return pool;
}

export function newNostrTestKey(): { nsec: string; privKey: Uint8Array; pubkey: string } {
  const privKey = generateSecretKey();
  return { nsec: nip19.nsecEncode(privKey), privKey, pubkey: getPublicKey(privKey) };
}

export function nsecToPubkey(nsec: string): { privKey: Uint8Array; pubkey: string } {
  const decoded = nip19.decode(nsec.trim());
  if (decoded.type !== 'nsec') throw new Error('Expected an nsec1… key');
  const privKey = decoded.data;
  return { privKey, pubkey: getPublicKey(privKey) };
}

export function npubToHex(npub: string): string {
  const decoded = nip19.decode(npub.trim());
  if (decoded.type === 'npub') return decoded.data;
  if (decoded.type === 'nprofile') return decoded.data.pubkey;
  throw new Error('Expected npub1… or nprofile1…');
}

/** Resolve name@domain NIP-05 identifier to a hex pubkey. */
export async function nip05ToPubkey(identifier: string): Promise<string> {
  const [name, domain] = identifier.trim().split('@');
  if (!name || !domain) throw new Error('Expected name@domain');
  const res = await fetch(
    `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`,
  );
  if (!res.ok) throw new Error(`NIP-05 fetch failed: HTTP ${res.status}`);
  const json = (await res.json()) as { names?: Record<string, string> };
  const pubkey = json.names?.[name.toLowerCase()] ?? json.names?.[name];
  if (!pubkey) throw new Error('NIP-05 name not found');
  return pubkey;
}

export function buildBindingEvent(
  binding: SilentTipBinding,
  pubkey?: string,
): EventTemplate {
  return {
    kind: BINDING_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', BINDING_D_TAG],
      ['t', 'silenttip'],
    ],
    content: JSON.stringify(binding),
    ...(pubkey ? { pubkey } : {}),
  } as EventTemplate;
}

export function signBinding(
  binding: SilentTipBinding,
  privKey: Uint8Array,
): Event {
  return finalizeEvent(buildBindingEvent(binding), privKey);
}

export async function publishEvent(
  event: Event,
  relays: string[] = DEFAULT_RELAYS,
): Promise<PublishResult[]> {
  const p = getPool();
  const results = await Promise.allSettled(p.publish(relays, event));
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? { relay: relays[i], ok: true }
      : {
          relay: relays[i],
          ok: false,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        },
  );
}

/** Fetch the newest valid binding event for a hex pubkey —
 *  skips unparseable events AND invalid signatures, so a relay serving a
 *  forged newer event cannot hide the real binding. */
export async function fetchBinding(
  pubkey: string,
  relays: string[] = DEFAULT_RELAYS,
): Promise<ResolvedBinding | null> {
  const p = getPool();
  const events = await p.querySync(relays, {
    kinds: [BINDING_KIND],
    authors: [pubkey],
    '#d': [BINDING_D_TAG],
  });
  const sorted = [...events].sort((a, b) => b.created_at - a.created_at);
  for (const event of sorted) {
    try {
      const binding = JSON.parse(event.content) as SilentTipBinding;
      if (binding.v !== 1 || typeof binding.sp !== 'string') continue;
      if (!verifyEvent(event)) continue;
      return { event, binding, pubkey: event.pubkey, signatureValid: true };
    } catch {
      continue;
    }
  }
  return null;
}

/** npub / nprofile / nip05 / raw hex → hex pubkey. */
export async function resolveIdentifier(input: string): Promise<string> {
  const v = input.trim();
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
  if (v.startsWith('npub1') || v.startsWith('nprofile1')) return npubToHex(v);
  if (v.includes('@')) return nip05ToPubkey(v);
  throw new Error('Enter an npub, nprofile, or name@domain NIP-05 identifier');
}

declare global {
  interface Window {
    nostr?: { signEvent: (event: EventTemplate) => Promise<Event>; getPublicKey?: () => Promise<string> };
  }
}

export function hasNip07(): boolean {
  return typeof window !== 'undefined' && !!window.nostr?.signEvent;
}

/** Sign with a NIP-07 browser extension when available. */
export async function signBindingNip07(binding: SilentTipBinding): Promise<Event> {
  if (!window.nostr?.signEvent) throw new Error('No NIP-07 signer found');
  const template = buildBindingEvent(binding);
  const pubkey = window.nostr.getPublicKey ? await window.nostr.getPublicKey() : undefined;
  return window.nostr.signEvent({ ...template, ...(pubkey ? { pubkey } : {}) });
}
