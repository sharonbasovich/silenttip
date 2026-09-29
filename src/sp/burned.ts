/**
 * Rotated demo identities whose private material became public:
 * - tsp1qqfjjuye… — scan/spend privkeys committed in an early
 *   scripts/regtest-proof.json revision (public git history).
 * - tsp1qq0nekn7… — mnemonic shown on screen in an early demo.mp4 revision.
 * Anyone can derive the spending key for outputs paying these addresses —
 * they are permanently compromised signet demo keys and must never be
 * tipped. The Tip tab warns when one resolves.
 */
export const BURNED_TSP1: readonly string[] = [
  'tsp1qqfjjuye7fjs4l9r73w86pnjr6j5kc93umzrs566p5gzxgj2ha6kycququrg9umwkk4nw2fd70a7w4wx6a9dztn7pqfdgc5kx43rgcprxlyhpz470',
  'tsp1qq0nekn7ye8ckm9d7unfl9c8w5vqcaup0m2quphwa8r6kfs3c6xs76quvrz2zt43zcmqtgyas9zzjm40800nhkddv88n0drz636awdxvv0yprxu3l',
];

export function isBurnedSp(sp: string): boolean {
  return BURNED_TSP1.includes(sp.trim());
}
