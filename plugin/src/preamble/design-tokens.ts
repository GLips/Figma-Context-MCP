/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// design-tokens — flcm.designTokens(), the read that lists the variables and styles a write can bind,
// so an agent builds with a file's tokens instead of retyping their literals.
//
// Summary first, because the two reaches cost very different amounts. The default call lists the
// file's local tokens and every token a page of the file is already bound to (the only way a plugin
// sees a library STYLE — the API has no list of a library's styles), and only CATALOGS the libraries
// enabled for the file: name, collections, a count each. Listing a library's variables means
// importing each one by key, since a library listing carries no values or id; on a real design system
// that is hundreds of network imports, over ten seconds. So it is a second call, for one library at a
// time: designTokens({ library, collection?, type? }).
//
// Each entry's `reference` comes from the core's own reference builders, the ones the read emits
// through, so a listed token and a read of a node bound to it can't spell the token differently.
//
// Negative space: grid styles and variable types past the four classic ones (EASING, …) are skipped,
// since flcm has no words to bind or spell them; so are variable bindings inside a style's gradient
// stops or effects, which the read doesn't emit either.
import { sceneFigma as figma } from "./scene-access.js";
import { scanUsedTokens } from "./tokens.js";
import { warnings } from "./warnings.js";
import { liveFontWords } from "./fonts.js";
import { decodeSceneEffect, decodeScenePaints, decodeSegmentStyle, type SceneEffect, type ScenePaint, type SceneTextSegment } from "./node-to-snapshot.js";
import {
  foldPaintStack, formatSolidColor, pixelRound, simplifyEffectStack, simplifyLiteralTextStyle,
  styleReference, variableReference,
} from "@framelink/core";
import type {
  DesignTokenLibrary, DesignTokenLibraryQuery, DesignTokens, DesignTokenStyle, DesignTokenVariable, DesignTokenVariableValue,
  LibraryDesignTokens,
} from "./ir.js";

type ListedStyle = PaintStyle | EffectStyle | TextStyle;
type ListedVariable = Variable & { resolvedType: DesignTokenVariable["type"] };
const LISTED_VARIABLE_TYPES: ReadonlySet<string> = new Set(["COLOR", "FLOAT", "STRING", "BOOLEAN"] satisfies DesignTokenVariable["type"][]);

export async function designTokens(): Promise<DesignTokens>;
export async function designTokens(from: DesignTokenLibraryQuery): Promise<LibraryDesignTokens>;
export async function designTokens(from?: unknown): Promise<DesignTokens | LibraryDesignTokens> {
  return from === undefined ? fileTokens() : libraryTokens(parseLibraryQuery(from));
}

async function fileTokens(): Promise<DesignTokens> {
  const localVariables = await figma.variables.getLocalVariablesAsync();
  const localStyles: BaseStyle[] = [
    ...(await figma.getLocalPaintStylesAsync()),
    ...(await figma.getLocalEffectStylesAsync()),
    ...(await figma.getLocalTextStylesAsync()),
  ];
  // Every page, not just the current one: an agent on a fresh page still builds with the tokens the
  // rest of the file uses.
  const pages = figma.root.children;
  for (const page of pages) await page.loadAsync();
  const used = await scanUsedTokens(pages);

  const variables = uniqueBy([...localVariables, ...used.variables], (v) => v.id);
  const styles = uniqueBy([...localStyles, ...used.styles], (s) => s.id)
    .filter((s): s is ListedStyle => s.type === "PAINT" || s.type === "EFFECT" || s.type === "TEXT");
  const describe = new VariableDescriber(listable(variables));
  return {
    variables: await describe.all(),
    styles: await Promise.all(styles.map((s) => describeStyle(s, describe))),
    libraries: await libraryCatalog(),
  };
}

function listable(variables: readonly Variable[]): ListedVariable[] {
  return variables.filter((v): v is ListedVariable => LISTED_VARIABLE_TYPES.has(v.resolvedType));
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(key(item)) && !!seen.add(key(item)));
}

const LIBRARY_QUERY_KEYS: ReadonlySet<string> = new Set(["library", "collection", "type"]);

// Hand-rolled: the preamble is zod-free. Fails loud on anything it doesn't know, like every flcm verb.
function parseLibraryQuery(from: unknown): DesignTokenLibraryQuery {
  const usage = "flcm.designTokens: pass nothing for the file's tokens, or { library, collection?, type? } to load one enabled library's variables";
  if (typeof from !== "object" || from === null || Array.isArray(from)) throw new Error(usage + ".");
  const query = from as Record<string, unknown>;
  const unknown = Object.keys(query).filter((k) => !LIBRARY_QUERY_KEYS.has(k));
  if (unknown.length) throw new Error(usage + "; unknown key " + unknown.map((k) => JSON.stringify(k)).join(", ") + ".");
  if (typeof query.library !== "string") throw new Error(usage + "; library must be the library's name, as the default call's libraries list it.");
  if (query.collection !== undefined && typeof query.collection !== "string") throw new Error(usage + "; collection must be a collection name.");
  if (query.type !== undefined && !LISTED_VARIABLE_TYPES.has(query.type as string)) {
    throw new Error(usage + "; type must be one of " + [...LISTED_VARIABLE_TYPES].join(", ") + ".");
  }
  return query as unknown as DesignTokenLibraryQuery;
}

const NO_TEAMLIBRARY = "this copy of the plugin lacks the teamlibrary permission. Re-import the plugin from its manifest to reach enabled libraries.";

// A plugin imported before the manifest granted `teamlibrary` still runs a newer server's preamble
// (ADR-0010), and Figma refuses the whole namespace there. Null means exactly that refusal.
async function enabledCollections(): Promise<LibraryVariableCollection[] | null> {
  try {
    return await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
  } catch (error) {
    if (!/teamlibrary/i.test(String(error))) throw error;
    return null;
  }
}

// The catalog degrades rather than failing the read: the file's own tokens are already in hand, and a
// library is the one reach that rides the network. A collection the user can't open drops out with a
// warning naming it; an empty one drops out silently, since there is nothing in it to load.
async function libraryCatalog(): Promise<DesignTokenLibrary[]> {
  const collections = await enabledCollections();
  if (!collections) {
    warnings.add({ id: null, message: "flcm.designTokens: enabled libraries are not listed, because " + NO_TEAMLIBRARY });
    return [];
  }
  const listed = await listCollections(collections);
  const libraries = new Map<string, DesignTokenLibrary>();
  collections.forEach((c, i) => {
    const variables = listed[i];
    if (!variables?.length) return;
    let library = libraries.get(c.libraryName);
    if (!library) libraries.set(c.libraryName, library = { name: c.libraryName, collections: [] });
    library.collections.push({ name: c.name, variables: variables.length });
  });
  return [...libraries.values()];
}

/** Each collection's variable listing, or null for one that couldn't be read (warned once, together). */
async function listCollections(collections: readonly LibraryVariableCollection[]): Promise<(LibraryVariable[] | null)[]> {
  const results = await Promise.all(collections.map((c) => settle(figma.teamLibrary.getVariablesInLibraryCollectionAsync(c.key))));
  const skipped = collections.filter((_, i) => !results[i].ok).map((c) => JSON.stringify(c.libraryName + " / " + c.name));
  if (skipped.length) warnings.add({ id: null, message: "flcm.designTokens: some library collections could not be read and are left out: " + skipped.join(", ") + "." });
  return results.map((r) => (r.ok ? r.value : null));
}

async function libraryTokens(query: DesignTokenLibraryQuery): Promise<LibraryDesignTokens> {
  const collections = await enabledCollections();
  if (!collections) throw new Error("flcm.designTokens: no library can be loaded, because " + NO_TEAMLIBRARY);
  const inLibrary = collections.filter((c) => c.libraryName === query.library);
  if (!inLibrary.length) {
    const names = [...new Set(collections.map((c) => c.libraryName))];
    throw new Error("flcm.designTokens: no enabled library with variables is named " + JSON.stringify(query.library) + ". " +
      (names.length ? "Enabled: " + names.map((n) => JSON.stringify(n)).join(", ") + "." : "This file has none enabled."));
  }
  const chosen = query.collection === undefined ? inLibrary : inLibrary.filter((c) => c.name === query.collection);
  if (!chosen.length) {
    throw new Error("flcm.designTokens: " + JSON.stringify(query.library) + " has no collection named " + JSON.stringify(query.collection) +
      ". Its collections: " + inLibrary.map((c) => JSON.stringify(c.name)).join(", ") + ".");
  }
  // The type filter runs on the listing, before any import, which is what makes it worth having.
  const listed = (await listCollections(chosen)).flatMap((variables) => variables ?? [])
    .filter((v) => query.type === undefined ? LISTED_VARIABLE_TYPES.has(v.resolvedType) : v.resolvedType === query.type);
  const imported = await settleInBatches(listed, (v) => figma.variables.importVariableByKeyAsync(v.key));
  const failed = imported.filter((r) => !r.ok).length;
  if (failed) warnings.add({ id: null, message: "flcm.designTokens: " + failed + " of " + listed.length + " variable imports from " + JSON.stringify(query.library) + " failed and are left out." });
  const variables = imported.flatMap((r) => (r.ok ? [r.value] : []));
  return { variables: await new VariableDescriber(listable(variables)).all() };
}

// Every import is a library request, and a design system can hold thousands of variables; a bounded
// batch keeps one read from opening them all at once.
const IMPORT_BATCH = 16;
async function settleInBatches<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<Settled<R>[]> {
  const out: Settled<R>[] = [];
  for (let i = 0; i < items.length; i += IMPORT_BATCH) out.push(...(await Promise.all(items.slice(i, i + IMPORT_BATCH).map((item) => settle(run(item))))));
  return out;
}

type Settled<R> = { ok: true; value: R } | { ok: false };
function settle<R>(promise: Promise<R>): Promise<Settled<R>> {
  return promise.then((value) => ({ ok: true as const, value }), () => ({ ok: false as const }));
}

// Collections and alias targets are looked up once each, however many variables share them.
class VariableDescriber {
  private readonly byId: Map<string, Variable>;
  private readonly collections = new Map<string, Promise<VariableCollection | null>>();

  constructor(private readonly variables: readonly ListedVariable[]) {
    this.byId = new Map(variables.map((v) => [v.id, v]));
  }

  async all(): Promise<DesignTokenVariable[]> {
    const described = await Promise.all(this.variables.map(async (v) => ({ v, collection: await this.collection(v.variableCollectionId) })));
    // Figma's own panel order: collections as listed, variables in each collection's order.
    const collectionOrder = [...new Set(described.map((d) => d.v.variableCollectionId))];
    const rank = ({ v, collection }: (typeof described)[number]) => [
      collectionOrder.indexOf(v.variableCollectionId),
      collection ? collection.variableIds.indexOf(v.id) : 0,
    ];
    described.sort((a, b) => {
      const [ca, ia] = rank(a), [cb, ib] = rank(b);
      return ca - cb || ia - ib;
    });
    return Promise.all(described.map(({ v, collection }) => this.describe(v, collection)));
  }

  /** A ref the core will emit, named when the variable can be found. */
  async ref(id: string): Promise<{ id: string; name?: string }> {
    let variable = this.byId.get(id);
    if (!variable) {
      const found = await figma.variables.getVariableByIdAsync(id);
      if (found) this.byId.set(id, variable = found);
    }
    return variable ? { id, name: variable.name } : { id };
  }

  private collection(id: string): Promise<VariableCollection | null> {
    let collection = this.collections.get(id);
    if (!collection) this.collections.set(id, collection = figma.variables.getVariableCollectionByIdAsync(id));
    return collection;
  }

  private async describe(v: ListedVariable, collection: VariableCollection | null): Promise<DesignTokenVariable> {
    // A collection Figma can't hand back still lists its variable, with values keyed by mode id.
    const modes = collection ? collection.modes : Object.keys(v.valuesByMode).map((modeId) => ({ modeId, name: modeId }));
    const values: Record<string, DesignTokenVariableValue> = {};
    for (const mode of modes) {
      if (mode.modeId in v.valuesByMode) values[mode.name] = await this.value(v.valuesByMode[mode.modeId]);
    }
    const entry: DesignTokenVariable = {
      reference: variableReference({ id: v.id, name: v.name }),
      collection: collection ? collection.name : v.variableCollectionId,
      type: v.resolvedType,
      values,
    };
    if (!(v.scopes.length === 1 && v.scopes[0] === "ALL_SCOPES")) entry.scopes = [...v.scopes];
    if (v.remote) entry.remote = true;
    return entry;
  }

  private async value(raw: VariableValue): Promise<DesignTokenVariableValue> {
    if (typeof raw === "number") return pixelRound(raw);
    if (typeof raw === "string" || typeof raw === "boolean") return raw;
    if ("type" in raw && raw.type === "VARIABLE_ALIAS") return variableReference(await this.ref(raw.id));
    const { r, g, b } = raw as RGB;
    return formatSolidColor({ r, g, b, a: "a" in raw ? raw.a : 1 });
  }
}

async function describeStyle(style: ListedStyle, variables: VariableDescriber): Promise<DesignTokenStyle> {
  const entry: DesignTokenStyle = {
    // The style's key is its id in every read; see node-to-snapshot's decodeStyleSlots.
    reference: styleReference({ id: style.key, name: style.name }),
    type: style.type,
  };
  const value = await styleValue(style, variables);
  if (value !== undefined) entry.value = value;
  if (style.remote) entry.remote = true;
  return entry;
}

async function styleValue(style: ListedStyle, variables: VariableDescriber): Promise<DesignTokenStyle["value"]> {
  if (style.type === "PAINT") {
    const paints = decodeScenePaints(style.paints as ReadonlyArray<ScenePaint>) ?? [];
    for (const paint of paints) {
      if (paint.type === "SOLID" && paint.colorVariable) paint.colorVariable = await variables.ref(paint.colorVariable.id);
    }
    return foldPaintStack(paints);
  }
  if (style.type === "EFFECT") {
    const effects = simplifyEffectStack(style.effects.map((e) => decodeSceneEffect(e as unknown as SceneEffect)), false);
    return Object.keys(effects).length ? effects : undefined;
  }
  // A text style is the segment a node set to it would report. A style has no weight or slant field of
  // its own — both live in its font's style label, which is where a segment's come from too.
  const { fontWeight, fontStyle } = liveFontWords(style.fontName);
  const decoded = decodeSegmentStyle({
    characters: "",
    fontName: style.fontName,
    fontWeight: fontWeight as number,
    fontStyle: fontStyle === "italic" ? "ITALIC" : "REGULAR",
    fontSize: style.fontSize,
    lineHeight: style.lineHeight as SceneTextSegment["lineHeight"],
    letterSpacing: style.letterSpacing,
    textCase: style.textCase,
    textDecoration: style.textDecoration,
    paragraphSpacing: style.paragraphSpacing,
    paragraphIndent: style.paragraphIndent,
    listSpacing: style.listSpacing,
    boundVariables: style.boundVariables as SceneTextSegment["boundVariables"],
  });
  if (decoded.boundVariables) {
    const named: typeof decoded.boundVariables = {};
    for (const [field, ref] of Object.entries(decoded.boundVariables) as [keyof typeof named, { id: string }][]) named[field] = await variables.ref(ref.id);
    decoded.boundVariables = named;
  }
  return simplifyLiteralTextStyle(decoded);
}
