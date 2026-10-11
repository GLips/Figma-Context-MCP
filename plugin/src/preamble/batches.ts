/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The preamble's one bound on fan-out. A verb that runs async work per item (a library import, an async
// find predicate that itself calls flcm) can face thousands of items; awaiting them in fixed batches
// overlaps Figma's async reads without opening every request at once.
const BATCH_SIZE = 16;

/** Runs `run` over `items` at most BATCH_SIZE at a time; results keep `items`' order, and a rejection rejects. */
export async function mapInBatches<T, R>(items: readonly T[], run: (item: T) => R | Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) out.push(...(await Promise.all(items.slice(i, i + BATCH_SIZE).map(run))));
  return out;
}
