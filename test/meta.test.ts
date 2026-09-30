/**
 * Repo-level regression checks for the *published surface*:
 * every referenced file must exist, docs must stay consistent with the
 * actual test surface, honesty guardrails must stay in place, and no
 * compromised/secret material may appear in committed text artifacts.
 * (Demo videos are binary — leaked-key checks there are manual; text
 * artifacts and code are checked here on every run.)
 */
import { describe, expect, it } from 'vitest';
import readme from '../README.md?raw';
import evidence from '../docs/evidence.md?raw';
import judgeNotes from '../docs/judge-notes.md?raw';
import devfolio from '../docs/devfolio-draft.md?raw';
import videoHtml from '../video.html?raw';
import indexHtml from '../index.html?raw';
import mainTs from '../src/main.ts?raw';
import gitignore from '../.gitignore?raw';
import vectorsJson from './vectors/send_and_receive_test_vectors.json';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { validateMnemonic } from '@scure/bip39';
import { BURNED_TSP1 } from '../src/sp/burned';

const DOCS: Record<string, string> = {
  'README.md': readme,
  'docs/evidence.md': evidence,
  'docs/judge-notes.md': judgeNotes,
  'docs/devfolio-draft.md': devfolio,
  'video.html': videoHtml,
  'index.html': indexHtml,
  'src/main.ts': mainTs,
};

const repoFiles = new Set(
  Object.keys(
    import.meta.glob([
      '../README.md',
      '../LICENSE',
      '../index.html',
      '../video.html',
      '../.gitignore',
      '../docs/**',
      '../src/**',
      '../test/**',
      '../scripts/**',
      '../public/**',
      '../.github/**',
    ]),
  ).map((p) =>
    p.startsWith('../') ? p.slice(3) : p.startsWith('./') ? `test/${p.slice(2)}` : p,
  ),
);

function referencedPaths(text: string): string[] {
  const out: string[] = [];
  // markdown links: [x](path) — skip http/#/mailto
  for (const m of text.matchAll(/\]\(([^)\s#]+)\)/g)) {
    if (!/^(https?|mailto):/.test(m[1])) out.push(m[1]);
  }
  // backticked repo-relative paths: `docs/x`, `src/y`, `scripts/z`, …
  for (const m of text.matchAll(
    /`((?:docs|src|scripts|test|public|\.github)\/[A-Za-z0-9._\-/]+)`/g,
  )) {
    out.push(m[1]);
  }
  return out;
}

function exists(path: string): boolean {
  const p = path.replace(/^\.\//, '');
  if (repoFiles.has(p)) return true;
  // directory references (e.g. docs/screenshots/, test/vectors/…)
  const prefix = p.endsWith('/') ? p : `${p}/`;
  return [...repoFiles].some((f) => f.startsWith(prefix) || f.startsWith(p.replace(/…$/, '')));
}

describe('published links & referenced files', () => {
  it('every markdown link and backticked path in the docs resolves', () => {
    const missing: string[] = [];
    for (const [doc, text] of Object.entries(DOCS)) {
      for (const p of referencedPaths(text)) {
        if (!exists(p)) missing.push(`${doc} -> ${p}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('video page references only media that ships in public/', () => {
    for (const m of videoHtml.matchAll(/(?:src|href)="\.\/([^"#]+)"/g)) {
      const p = m[1];
      // pages resolve ./x at site root = index/video.html at repo root,
      // everything else is copied from public/
      const candidates = [p, `public/${p}`];
      expect(
        candidates.some((c) => repoFiles.has(c)),
        `video.html references missing ${m[1]}`,
      ).toBe(true);
    }
  });

  it('demo + regtest videos are present', () => {
    expect(repoFiles.has('public/demo.mp4')).toBe(true);
    expect(repoFiles.has('public/regtest-proof.mp4')).toBe(true);
  });
});

describe('doc accuracy', () => {
  it('vector count claims match the vendored vector file', () => {
    const n = (vectorsJson as unknown[]).length;
    for (const [doc, text] of Object.entries(DOCS)) {
      for (const m of text.matchAll(/(\d+)\s+official\s+(?:bitcoin\/bips\s+)?BIP-352/gi)) {
        expect(Number(m[1]), `${doc}: "${m[0]}" vs ${n} vectors`).toBe(n);
      }
    }
  });

  it('test-count claims are consistent across docs', () => {
    const counts = new Set<number>();
    for (const text of Object.values(DOCS)) {
      for (const m of text.matchAll(/\b(\d+)\s+tests\b/g)) counts.add(Number(m[1]));
    }
    expect([...counts].length, `divergent test counts: ${[...counts]}`).toBeLessThanOrEqual(1);
  });

  it('docs named in the README are non-empty', () => {
    for (const doc of ['docs/evidence.md', 'docs/judge-notes.md', 'docs/devfolio-draft.md']) {
      expect(
        DOCS[doc].trim().length,
        `${doc} is empty — README links to it`,
      ).toBeGreaterThan(1000);
    }
  });

  it('every burned identity is documented in evidence.md', () => {
    for (const tsp1 of BURNED_TSP1) {
      expect(evidence.includes(tsp1.slice(0, 20)), `burned ${tsp1.slice(0, 16)}… undocumented`).toBe(
        true,
      );
    }
  });
});

describe('honesty guardrails', () => {
  it('evidence.md keeps the explicit no-signet-broadcast statement', () => {
    expect(evidence).toContain('NOT YET EXECUTED');
  });

  it('public-facing copy keeps the sender-inputs limitation', () => {
    const flat = (s: string) => s.replace(/\s+/g, ' ');
    expect(flat(videoHtml)).toContain('Sender inputs');
    expect(flat(mainTs)).toContain('Sender inputs');
  });

  it('no absolute privacy/anonymity claims anywhere in copy', () => {
    for (const [doc, text] of Object.entries(DOCS)) {
      expect(
        /\b(untraceable|anonymous|anonymity|never be traced|completely private|fully private)\b/i.test(
          text,
        ),
        `${doc} contains an absolute privacy claim`,
      ).toBe(false);
    }
  });
});

describe('no leaked secrets in committed text artifacts', () => {
  const textArtifacts = Object.entries(
    import.meta.glob(
      [
        '../README.md',
        '../LICENSE',
        '../index.html',
        '../video.html',
        '../.gitignore',
        '../docs/**',
        '../src/**',
        '../test/**',
        '../scripts/**',
        '../.github/**',
      ],
      { query: '?raw', import: 'default', eager: true },
    ) as Record<string, string>,
  );

  // regtest-proof.json deliberately commits disposable regtest-only keys;
  // this test file legitimately names the banned patterns it scans for
  const allowed = new Set(['../scripts/regtest-proof.json', '../test/meta.test.ts']);

  // a checksum-valid BIP39 mnemonic in a committed file is a real seed —
  // sliding windows of 12/24 lowercase-alpha tokens catch it without the
  // false positives that plain wordlist-membership runs produce
  const BIP39 = new Set(wordlist);
  const hasValidMnemonic = (text: string): boolean => {
    const tokens = text.toLowerCase().match(/[a-z]+/g) ?? [];
    for (const len of [12, 24]) {
      for (let i = 0; i + len <= tokens.length; i++) {
        const win = tokens.slice(i, i + len);
        if (win.every((w) => BIP39.has(w)) && validateMnemonic(win.join(' '), wordlist)) {
          return true;
        }
      }
    }
    return false;
  };

  const patterns: { name: string; test: (t: string) => boolean }[] = [
    {
      name: 'burned video mnemonic',
      test: (t) => /demise organ notable magic family allow spirit/i.test(t),
    },
    { name: 'nostr secret key', test: (t) => /nsec1[02-9ac-hj-np-z]{10,}/.test(t) },
    { name: 'testnet WIF private key', test: (t) => /\bcM[1-9A-HJ-NP-Za-km-z]{50}\b/.test(t) },
    { name: 'checksum-valid BIP39 mnemonic', test: hasValidMnemonic },
  ];

  it('no banned strings in committed text files', () => {
    const hits: string[] = [];
    for (const [path, text] of textArtifacts) {
      if (allowed.has(path)) continue;
      for (const { name, test } of patterns) {
        if (test(text)) hits.push(`${path}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('gitignore still protects the live identity state file', () => {
    expect(gitignore).toMatch(/\.e2e-state\.json/);
    expect(repoFiles.has('scripts/.e2e-state.json')).toBe(false);
    expect(repoFiles.has('scripts/dist/.e2e-state.json')).toBe(false);
  });
});
