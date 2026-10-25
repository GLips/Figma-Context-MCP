/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// design-tokens — flcm.designTokens(), the read that lists the variables and styles a write can bind,
// so an agent builds with a file's tokens instead of retyping their literals.
//
// Summary first, because a file's own tokens are few and the library tokens it reaches can be
// thousands. The default call lists the file's LOCAL tokens in full and only COUNTS the rest: the
// library tokens something in the file is bound to (by collection, and styles by type), and the
// libraries enabled for the file. Each count is a call away: designTokens({ used: true, … }) for the
// used ones — the only way a plugin sees a library STYLE, since the API has no list of a library's
// styles — and designTokens({ library, … }) for an enabled library, which imports each variable by
// key (a listing carries no values or id), hundreds of network imports on a real design system.
//
// Each entry's `reference` comes from the core's own reference builders, the ones the read emits
// through, and is named-only exactly when the read's would be — both ask the write side's
// TokenLookups — so a listed token and a read of a node bound to it can't spell the token differently.
//
// Negative space: grid styles and variable types past the four classic ones (EASING, …) are skipped,
// since flcm has no words to bind or spell them; so are variable bindings inside a style's gradient
// stops or effects, which the read doesn't emit either.
import { sceneFigma as figma } from "./scene-access.js";
import { FlcmError } from "./flcm-error.js";
import { enabledLibraryListing, scanUsedTokens, TokenLookups } from "./tokens.js";
import { warnings } from "./warnings.js";
import { mapInBatches } from "./batches.js";
import { liveFontWords } from "./fonts.js";
import { decodeSceneEffect, decodeScenePaints, decodeSegmentStyle } from "./node-to-snapshot.js";
import {
  foldPaintStack, formatSolidColor, pixelRound, simplifyEffectStack, simplifyLiteralTextStyle,
  styleReference, variableReference,
} from "@framelink/core";
import type { SnapshotTokenRef } from "@framelink/core/snapshot";
import type {
  DesignTokenLibrary, DesignTokenLibraryQuery, DesignTokens, DesignTokensUsed, DesignTokenStyle, DesignTokenUsedCollection,
  DesignTokenUsedQuery, DesignTokenVariable, DesignTokenVariableValue, LibraryDesignTokens, UsedDesignTokens,
} from "./ir.js";

type ListedStyle = PaintStyle | EffectStyle | TextStyle;
type ListedVariable = Variable & { resolvedType: DesignTokenVariable["type"] };
const LISTED_VARIABLE_TYPES: ReadonlySet<string> = new Set(["COLOR", "FLOAT", "STRING", "BOOLEAN"] satisfies DesignTokenVariable["type"][]);
const LISTED_STYLE_TYPES: ReadonlySet<string> = new Set(["PAINT", "EFFECT", "TEXT"] satisfies DesignTokenStyle["type"][]);

export async function designTokens(): Promise<DesignTokens>;
export async function designTokens(from: DesignTokenUsedQuery): Promise<UsedDesignTokens>;
export async function designTokens(from: DesignTokenLibraryQuery): Promise<LibraryDesignTokens>;
export async function designTokens(from?: unknown): Promise<DesignTokens | UsedDesignTokens | LibraryDesignTokens> {
  if (from === undefined) return fileTokens();
  const query = parseTokenQuery(from);
  return "used" in query ? usedTokens(query) : libraryTokens(query);
}

async function fileTokens(): Promise<DesignTokens> {
  const localVariables = await figma.variables.getLocalVariablesAsync();
  const localStyles: BaseStyle[] = [
    ...(await figma.getLocalPaintStylesAsync()),
    ...(await figma.getLocalEffectStylesAsync()),
    ...(await figma.getLocalTextStylesAsync()),
  ];
  const lookups = new TokenLookups();
  const describe = new VariableDescriber(listable(localVariables), lookups);
  const catalog = await libraryCatalog();
  return {
    variables: await describe.all(),
    styles: await Promise.all(listableStyles(localStyles).map((s) => describeStyle(s, describe, lookups))),
    used: await countUsed(await usedLibraryTokens(), catalog.libraryOf),
    libraries: catalog.libraries,
  };
}

// Every page, not just the current one: an agent on a fresh page still builds with the tokens the
// rest of the file uses. Local tokens are left out — the default call lists every one of them.
async function usedLibraryTokens(): Promise<{ variables: ListedVariable[]; styles: ListedStyle[] }> {
  const pages = figma.root.children;
  for (const page of pages) await page.loadAsync();
  const used = await scanUsedTokens(pages);
  return {
    variables: listable(uniqueBy(used.variables, (v) => v.id).filter((v) => v.remote)),
    styles: listableStyles(uniqueBy(used.styles, (s) => s.id).filter((s) => s.remote)),
  };
}

async function countUsed(used: { variables: ListedVariable[]; styles: ListedStyle[] }, libraryOf: ReadonlyMap<string, string>): Promise<DesignTokensUsed> {
  const names = new Map<string, Promise<string>>();
  const collectionName = (id: string) => {
    if (!names.has(id)) names.set(id, figma.variables.getVariableCollectionByIdAsync(id).then((c) => (c ? c.name : id)));
    return names.get(id)!;
  };
  // Keyed by what an entry shows, not by collection id: same-named collections of unknown libraries
  // can't be told apart, and a { used, collection } load takes them together, so they count together.
  const counted = new Map<string, DesignTokenUsedCollection>();
  for (const v of used.variables) {
    const name = await collectionName(v.variableCollectionId);
    const library = libraryOf.get(v.key);
    const key = JSON.stringify([name, library]);
    const entry = counted.get(key);
    if (entry) entry.variables++;
    else counted.set(key, library === undefined ? { name, variables: 1 } : { name, library, variables: 1 });
  }
  const collections = [...counted.values()];
  const styles = new Map<DesignTokenStyle["type"], number>();
  for (const s of used.styles) styles.set(s.type, (styles.get(s.type) ?? 0) + 1);
  return { collections, styles: [...styles].map(([type, count]) => ({ type, styles: count })) };
}

async function usedTokens(query: DesignTokenUsedQuery): Promise<UsedDesignTokens> {
  const used = await usedLibraryTokens();
  const lookups = new TokenLookups();
  let variables = query.type === undefined || LISTED_VARIABLE_TYPES.has(query.type) ? used.variables : [];
  let styles = query.collection === undefined && (query.type === undefined || LISTED_STYLE_TYPES.has(query.type)) ? used.styles : [];
  if (query.type !== undefined) variables = variables.filter((v) => v.resolvedType === query.type);
  if (query.type !== undefined) styles = styles.filter((s) => s.type === query.type);
  if (query.collection !== undefined) {
    const named = await Promise.all(variables.map(async (v) => (await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId))?.name));
    const inCollection = variables.filter((_, i) => named[i] === query.collection);
    if (!inCollection.length) {
      const names = [...new Set(named.filter((n): n is string => n !== undefined))];
      throw new FlcmError("authoring", "no used library variable" + (query.type === undefined ? "" : " of type " + query.type) +
        " is in a collection named " + JSON.stringify(query.collection) + ". " +
        (names.length ? "Pass one of the collections it uses: " + names.map((n) => JSON.stringify(n)).join(", ") + "." : "The file uses no library variables" + (query.type === undefined ? "" : " of that type") + ": drop collection."));
    }
    variables = inCollection;
  }
  const describe = new VariableDescriber(variables, lookups, (await libraryCatalog()).libraryOf);
  return { variables: await describe.all(), styles: await Promise.all(styles.map((s) => describeStyle(s, describe, lookups))) };
}

function listable(variables: readonly Variable[]): ListedVariable[] {
  return variables.filter((v): v is ListedVariable => LISTED_VARIABLE_TYPES.has(v.resolvedType));
}

function listableStyles(styles: readonly BaseStyle[]): ListedStyle[] {
  return styles.filter((s): s is ListedStyle => LISTED_STYLE_TYPES.has(s.type));
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(key(item)) && !!seen.add(key(item)));
}

const LIBRARY_QUERY_KEYS: ReadonlySet<string> = new Set(["library", "collection", "type"]);
const USED_QUERY_KEYS: ReadonlySet<string> = new Set(["used", "collection", "type"]);

// Hand-rolled: the preamble is zod-free. Fails loud on anything it doesn't know, like every flcm verb.
function parseTokenQuery(from: unknown): DesignTokenUsedQuery | DesignTokenLibraryQuery {
  const usage = "Pass nothing for the file's own tokens, { used: true, collection?, type? } for the library tokens it uses, " +
    "or { library, collection?, type? } to load one enabled library's variables.";
  const refuse = (problem: string) => new FlcmError("authoring", problem + " " + usage);
  if (typeof from !== "object" || from === null || Array.isArray(from)) throw refuse("the query must be an object.");
  const query = from as Record<string, unknown>;
  const used = "used" in query;
  if (used && query.used !== true) throw refuse("used must be true.");
  if (used && "library" in query) throw refuse("used and library are two different loads — pass one.");
  const known = used ? USED_QUERY_KEYS : LIBRARY_QUERY_KEYS;
  const unknown = Object.keys(query).filter((k) => !known.has(k));
  if (unknown.length) throw refuse("unknown key " + unknown.map((k) => JSON.stringify(k)).join(", ") + ".");
  if (!used && typeof query.library !== "string") throw refuse("library must be the library's name, as flcm.designTokens() lists it under libraries.");
  if (query.collection !== undefined && typeof query.collection !== "string") throw refuse("collection must be a collection name.");
  const types = used ? [...LISTED_VARIABLE_TYPES, ...LISTED_STYLE_TYPES] : [...LISTED_VARIABLE_TYPES];
  if (query.type !== undefined && !types.includes(query.type as string)) throw refuse("type must be one of " + types.join(", ") + ".");
  if (used && query.collection !== undefined && LISTED_STYLE_TYPES.has(query.type as string)) {
    throw refuse("a collection holds variables, so it can't be narrowed to a style type.");
  }
  return query as unknown as DesignTokenUsedQuery | DesignTokenLibraryQuery;
}

/** The run's listing of enabled collections with variables, warning once about any unreadable one. */
async function listedLibraries(): Promise<{ collection: LibraryVariableCollection; variables: LibraryVariable[] }[]> {
  const listing = await enabledLibraryListing();
  const skipped = listing.filter((c) => !c.variables).map(({ collection: c }) => JSON.stringify(c.libraryName + " / " + c.name));
  if (skipped.length) warnings.add({ id: null, message: "flcm.designTokens: some library collections could not be read and are left out: " + skipped.join(", ") + "." });
  return listing.flatMap(({ collection, variables }) => (variables?.length ? [{ collection, variables }] : []));
}

// The catalog degrades rather than failing the read: the file's own tokens are already in hand, and a
// library is the one reach that rides the network. A collection the user can't open drops out with a
// warning naming it; an empty one drops out silently, since there is nothing in it to load.
// `libraryOf` maps each listed variable's key to its library's name — the one way to tell which
// enabled library a used remote variable came from.
async function libraryCatalog(): Promise<{ libraries: DesignTokenLibrary[]; libraryOf: Map<string, string> }> {
  const libraryOf = new Map<string, string>();
  const listed = await listedLibraries();
  const libraries = new Map<string, DesignTokenLibrary>();
  for (const { collection: c, variables } of listed) {
    for (const v of variables) libraryOf.set(v.key, c.libraryName);
    let library = libraries.get(c.libraryName);
    if (!library) libraries.set(c.libraryName, library = { name: c.libraryName, collections: [] });
    library.collections.push({ name: c.name, variables: variables.length });
  }
  return { libraries: [...libraries.values()], libraryOf };
}

async function libraryTokens(query: DesignTokenLibraryQuery): Promise<LibraryDesignTokens> {
  const listed = await listedLibraries();
  const inLibrary = listed.filter(({ collection: c }) => c.libraryName === query.library);
  if (!inLibrary.length) {
    const names = [...new Set(listed.map(({ collection: c }) => c.libraryName))];
    throw new FlcmError("authoring", "no enabled library with variables is named " + JSON.stringify(query.library) + ". " +
      (names.length ? "Pass one of the enabled libraries: " + names.map((n) => JSON.stringify(n)).join(", ") + "." : "This file has no library with variables enabled; enable one in Figma first."));
  }
  const chosen = query.collection === undefined ? inLibrary : inLibrary.filter(({ collection: c }) => c.name === query.collection);
  if (!chosen.length) {
    throw new FlcmError("authoring", JSON.stringify(query.library) + " has no collection named " + JSON.stringify(query.collection) +
      ". Pass one of its collections: " + inLibrary.map(({ collection: c }) => JSON.stringify(c.name)).join(", ") + ".");
  }
  // The type filter runs on the listing, before any import, which is what makes it worth having.
  const wanted = chosen.flatMap(({ variables }) => variables)
    .filter((v) => query.type === undefined ? LISTED_VARIABLE_TYPES.has(v.resolvedType) : v.resolvedType === query.type);
  // Every import is a library request, and a design system can hold thousands of variables.
  const imported = await mapInBatches(wanted, (v) => settle(figma.variables.importVariableByKeyAsync(v.key)));
  const failed = imported.filter((r) => !r.ok).length;
  if (failed) warnings.add({ id: null, message: "flcm.designTokens: " + failed + " of " + wanted.length + " variable imports from " + JSON.stringify(query.library) + " failed and are left out." });
  const variables = imported.flatMap((r) => (r.ok ? [r.value] : []));
  const libraryOf = new Map(wanted.map((v) => [v.key, query.library]));
  return { variables: await new VariableDescriber(listable(variables), new TokenLookups(), libraryOf).all() };
}

type Settled<R> = { ok: true; value: R } | { ok: false };
function settle<R>(promise: Promise<R>): Promise<Settled<R>> {
  return promise.then((value) => ({ ok: true as const, value }), () => ({ ok: false as const }));
}

// Collections and alias targets are looked up once each, however many variables share them.
class VariableDescriber {
  private readonly byId: Map<string, Variable>;
  private readonly collections = new Map<string, Promise<VariableCollection | null>>();

  /** `libraryOf` names an entry's library by the variable's key, when it's in an enabled library. */
  constructor(
    private readonly variables: readonly ListedVariable[],
    private readonly lookups: TokenLookups,
    private readonly libraryOf: ReadonlyMap<string, string> = new Map(),
  ) {
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

  /** A ref the core will emit: named when the variable can be found, and by name alone when that binds it. */
  async ref(id: string): Promise<SnapshotTokenRef> {
    let variable = this.byId.get(id);
    if (!variable) {
      const found = await figma.variables.getVariableByIdAsync(id);
      if (found) this.byId.set(id, variable = found);
    }
    if (!variable) return { id };
    return (await this.lookups.nameBindsVariable(variable)) ? { id, name: variable.name, nameSuffices: true } : { id, name: variable.name };
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
      reference: variableReference(await this.ref(v.id)),
      collection: collection ? collection.name : v.variableCollectionId,
      ...(this.libraryOf.has(v.key) ? { library: this.libraryOf.get(v.key)! } : {}),
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

async function describeStyle(style: ListedStyle, variables: VariableDescriber, lookups: TokenLookups): Promise<DesignTokenStyle> {
  // The style's key is its id in every read; see node-to-snapshot's decodeStyleSlots.
  const ref: SnapshotTokenRef = (await lookups.nameBindsStyle(style)) ? { id: style.key, name: style.name, nameSuffices: true } : { id: style.key, name: style.name };
  const entry: DesignTokenStyle = {
    reference: styleReference(ref),
    type: style.type,
  };
  const value = await styleValue(style, variables);
  if (value !== undefined) entry.value = value;
  if (style.remote) entry.remote = true;
  return entry;
}

async function styleValue(style: ListedStyle, variables: VariableDescriber): Promise<DesignTokenStyle["value"]> {
  if (style.type === "PAINT") {
    const paints = decodeScenePaints(style.paints) ?? [];
    for (const paint of paints) {
      if (paint.type === "SOLID" && paint.colorVariable) paint.colorVariable = await variables.ref(paint.colorVariable.id);
    }
    return foldPaintStack(paints);
  }
  if (style.type === "EFFECT") {
    const effects = simplifyEffectStack(style.effects.map((e) => decodeSceneEffect(e)), false);
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
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    textCase: style.textCase,
    textDecoration: style.textDecoration,
    paragraphSpacing: style.paragraphSpacing,
    paragraphIndent: style.paragraphIndent,
    listSpacing: style.listSpacing,
    boundVariables: style.boundVariables,
  });
  if (decoded.boundVariables) {
    const named: typeof decoded.boundVariables = {};
    for (const [field, ref] of Object.entries(decoded.boundVariables) as [keyof typeof named, { id: string }][]) named[field] = await variables.ref(ref.id);
    decoded.boundVariables = named;
  }
  return simplifyLiteralTextStyle(decoded);
}
