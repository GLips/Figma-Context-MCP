/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// tokens — design tokens (variables and shared styles) as WRITE input, in three parts that run in the
// pipeline's three phases:
//
//   compile  pure. `{ variable }` / `{ style }` author input becomes a TokenRef that records which token
//            was named (id, name, or both — id wins) and what kind the word needs. The loose write forms
//            (`{ variable: "name-or-id" }`, `{ variable: { name } }`, …) all normalize here, so a read's
//            `{ variable: { id, name } }` and an author's `{ variable: "color/primary" }` meet one shape.
//   prepare  async. resolveTokenRefs looks every ref up — by id, else by name among the file's local
//            tokens, else among the tokens the current page already uses (how a library token is found
//            by name) — and refuses an unknown, ambiguous or wrong-kind token before any write.
//   apply    sync. The binders below write a ref onto a live node from what prepare resolved, keyed by
//            CONTENT (tokenKey) because edit compiles its delta twice and the gate's refs are new objects.
//
// Negative space: creating variables or styles is not here. Listing what exists is design-tokens.ts,
// which shares scanUsedTokens below.
import { sceneFigma as figma } from "./scene-access.js";
import { isTokenRef } from "./ir.js";
import type { VariableRef, StyleRef, TokenRef, Bindable } from "./ir.js";

// ---- compile ----

type VariableType = VariableRef["resolvedType"];
type StyleType = StyleRef["styleType"];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Author input naming a variable: any plain object carrying a `variable` key. */
export function isVariableInput(value: unknown): value is { variable: unknown } {
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, "variable");
}

/** Author input naming a style: any plain object carrying a `style` key. */
export function isStyleInput(value: unknown): value is { style: unknown } {
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, "style");
}

// Figma's own id grammars. A string that matches one is an id; anything else is a name. A style is
// named by its plugin id (`S:…`) or its key — the 40-hex form the read emits — and no style name is
// either in practice.
const VARIABLE_ID = /^VariableID:/;
const STYLE_ID = /^S:/;
const STYLE_KEY = /^[0-9a-f]{40}$/i;

function tokenIdentity(raw: unknown, token: "variable" | "style", word: string): { id?: string; name?: string } {
  if (typeof raw === "string" && raw.trim()) {
    const isId = token === "variable" ? VARIABLE_ID.test(raw) : STYLE_ID.test(raw) || STYLE_KEY.test(raw);
    return isId ? { id: raw } : { name: raw };
  }
  if (isPlainObject(raw)) {
    const extra = Object.keys(raw).filter((k) => k !== "id" && k !== "name");
    const id = raw.id, name = raw.name;
    const ok = (v: unknown) => v === undefined || (typeof v === "string" && v.trim() !== "");
    if (!extra.length && ok(id) && ok(name) && (id !== undefined || name !== undefined)) {
      const out: { id?: string; name?: string } = {};
      if (id !== undefined) out.id = id as string;
      if (name !== undefined) out.name = name as string;
      return out;
    }
  }
  throw new Error(
    word + ": `" + token + "` names a " + token + ' by name or id — "color/primary", { name }, { id }, or the read\'s { id, name }. Got ' +
      JSON.stringify(raw) + ".",
  );
}

/**
 * Compile a `{ variable }` input standing in for `word`. A read's `value` (the literal the variable
 * resolved to) is accepted and ignored, so a read pastes back as the binding it was.
 */
export function compileVariableRef(input: { variable: unknown }, word: string, resolvedType: VariableType): VariableRef {
  const extra = Object.keys(input).filter((k) => k !== "variable" && k !== "value");
  if (extra.length) {
    throw new Error(
      word + ": a variable reference is { variable } (and a read's `value`) alone — " + extra.map((k) => "`" + k + "`").join(", ") +
        " can't ride beside it." + (resolvedType === "COLOR" ? ' For a bound solid with its own opacity or blend, write { type: "SOLID", color: { variable }, opacity, blendMode }.' : ""),
    );
  }
  return { token: "variable", ...tokenIdentity(input.variable, "variable", word), word, resolvedType };
}

/** Compile the value under a `style` key (the slot's `{ style }`, or textStyle's `style` word). */
export function compileStyleRef(raw: unknown, word: string, styleType: StyleType): StyleRef {
  return { token: "style", ...tokenIdentity(raw, "style", word), word, styleType };
}

/**
 * A numeric-or-literal word that a variable may stand in for: the variable's ref, or the literal the
 * word's own parser produces. A `{ style }` here is refused by name — a style names a whole paint,
 * effect or text slot, never one number.
 */
export function compileBindable<T>(value: unknown, word: string, resolvedType: VariableType, literal: (v: never) => T): Bindable<T> {
  if (isVariableInput(value)) return compileVariableRef(value, word, resolvedType);
  if (isStyleInput(value)) {
    throw new Error(word + ": a style names a whole paint, effect or text slot, so it can't stand for one value. Bind a variable ({ variable }) or give the literal.");
  }
  return literal(value as never);
}

/** Refuse a token input where none can bind, naming the word and why (the contract's negative space). */
export function refuseTokenInput(value: unknown, word: string, why: string): void {
  if (isVariableInput(value) || isStyleInput(value)) throw new Error(word + ": " + why + ". Give the literal value.");
}

// ---- prepare ----

/** Content identity: what was named and what it must be. Two refs with one key resolve once. */
export function tokenKey(ref: TokenRef): string {
  const kind = ref.token === "variable" ? ref.resolvedType : ref.styleType;
  return ref.token + "|" + kind + "|" + (ref.id ?? "") + "|" + (ref.name ?? "");
}

export interface ResolvedVariable {
  variable: Variable;
  /** The default mode's value, aliases followed — what a node shows unless a mode overrides it. */
  literal: VariableValue;
  /** Every mode's value, aliases followed. Font words load each of these, since a mode switch re-fonts the node. */
  values: VariableValue[];
}

export interface ResolvedTokens {
  variables: ReadonlyMap<string, ResolvedVariable>;
  styles: ReadonlyMap<string, BaseStyle>;
}

export const NO_TOKENS: ResolvedTokens = { variables: new Map(), styles: new Map() };

export function mergeResolvedTokens(...all: readonly ResolvedTokens[]): ResolvedTokens {
  const variables = new Map<string, ResolvedVariable>();
  const styles = new Map<string, BaseStyle>();
  for (const t of all) {
    t.variables.forEach((v, k) => variables.set(k, v));
    t.styles.forEach((s, k) => styles.set(k, s));
  }
  return { variables, styles };
}

// Keys whose values are raw author input or live-tree bookkeeping, never compiled IR — a raw
// `{ variable }` there is compiled (and walked) wherever it actually lands.
const UNCOMPILED_KEYS = new Set(["source", "authoring", "overrides", "componentProperties", "component"]);

/**
 * Every TokenRef in compiled IR — a structural walk rather than a list of paint and text sites, so a
 * new bindable word is covered the day it compiles to a ref, with no second list to keep in step.
 */
export function collectTokenRefs(roots: readonly unknown[]): TokenRef[] {
  const out: TokenRef[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if (isTokenRef(value)) { out.push(value); return; }
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, child] of Object.entries(value)) if (!UNCOMPILED_KEYS.has(key)) visit(child);
  };
  roots.forEach(visit);
  return out;
}

const STYLE_TYPE_NOUN: Record<StyleType, string> = { PAINT: "color", EFFECT: "effect", TEXT: "text" };
const LIST_CAP = 5;

function capped(items: readonly string[]): string {
  const shown = items.slice(0, LIST_CAP).join("; ");
  return items.length > LIST_CAP ? shown + "; and " + (items.length - LIST_CAP) + " more" : shown;
}

/**
 * Resolve every ref before the seal. Unknown, ambiguous and wrong-kind tokens throw here, naming the
 * word and listing candidates, so a bad name costs zero writes. Lookups are deduped by tokenKey and the
 * page scan runs at most once, only when a name misses the file's local tokens.
 */
export async function resolveTokenRefs(refs: readonly TokenRef[]): Promise<ResolvedTokens> {
  if (!refs.length) return NO_TOKENS;
  const variables = new Map<string, ResolvedVariable>();
  const styles = new Map<string, BaseStyle>();
  const lookups = new TokenLookups();
  for (const ref of refs) {
    const key = tokenKey(ref);
    if (variables.has(key) || styles.has(key)) continue;
    if (ref.token === "variable") {
      const variable = await lookups.variable(ref);
      variables.set(key, await describeVariable(variable));
    } else {
      styles.set(key, await lookups.style(ref));
    }
  }
  return { variables, styles };
}

// The file's tokens as candidates for a name: local first, then — lazily, once — those the current page
// uses, which is the only reach a plugin has into an enabled library without its keys.
class TokenLookups {
  private localVariables?: Promise<Variable[]>;
  private localStyles?: Promise<BaseStyle[]>;
  private pageUsed?: Promise<{ variables: Variable[]; styles: BaseStyle[] }>;
  private collections = new Map<string, Promise<VariableCollection | null>>();

  async variable(ref: VariableRef): Promise<Variable> {
    if (ref.id !== undefined) {
      const byId = await figma.variables.getVariableByIdAsync(ref.id);
      if (byId) return this.checkVariableKind(byId, ref);
      if (ref.name === undefined) throw new Error(ref.word + ": no variable has the id " + JSON.stringify(ref.id) + " in this file — it may be deleted, or from a library this file hasn't enabled. Name it instead.");
    }
    const name = ref.name!;
    this.localVariables ??= figma.variables.getLocalVariablesAsync();
    let named = (await this.localVariables).filter((v) => v.name === name);
    if (!named.length) named = (await this.page()).variables.filter((v) => v.name === name);
    const fitting = named.filter((v) => v.resolvedType === ref.resolvedType);
    if (fitting.length === 1) return fitting[0];
    if (fitting.length > 1) {
      throw new Error(
        ref.word + ": " + fitting.length + " " + ref.resolvedType + " variables are named " + JSON.stringify(name) + " — name one by id: " +
          capped(await Promise.all(fitting.map((v) => this.describeCandidate(v)))) + ".",
      );
    }
    if (named.length) throw this.wrongVariableKind(named[0], ref);
    const all = [...(await this.localVariables), ...(await this.page()).variables].filter((v) => v.resolvedType === ref.resolvedType);
    const near = nearestNames(name, all.map((v) => v.name));
    throw new Error(
      ref.word + ": no " + ref.resolvedType + " variable is named " + JSON.stringify(name) + " in this file's variables or on this page" +
        (ref.id !== undefined ? " (and its id " + JSON.stringify(ref.id) + " is gone)" : "") +
        (near.length ? ". Nearest: " + capped(near.map((n) => JSON.stringify(n))) : "") + ".",
    );
  }

  async style(ref: StyleRef): Promise<BaseStyle> {
    if (ref.id !== undefined) {
      const byId = STYLE_ID.test(ref.id) ? await figma.getStyleByIdAsync(ref.id) : await this.styleByKey(ref.id);
      if (byId) return this.checkStyleKind(byId, ref);
      if (ref.name === undefined) throw new Error(ref.word + ": no style has the id " + JSON.stringify(ref.id) + " in this file — it may be deleted, or from a library this file hasn't enabled. Name it instead.");
    }
    const name = ref.name!;
    let named = (await this.local()).filter((s) => s.name === name);
    if (!named.length) named = (await this.page()).styles.filter((s) => s.name === name);
    const fitting = named.filter((s) => s.type === ref.styleType);
    if (fitting.length === 1) return fitting[0];
    if (fitting.length > 1) {
      throw new Error(
        ref.word + ": " + fitting.length + " " + STYLE_TYPE_NOUN[ref.styleType] + " styles are named " + JSON.stringify(name) + " — name one by id: " +
          capped(fitting.map((s) => JSON.stringify(s.name) + " (id " + s.id + ")")) + ".",
      );
    }
    if (named.length) throw this.wrongStyleKind(named[0], ref);
    const all = [...(await this.local()), ...(await this.page()).styles].filter((s) => s.type === ref.styleType);
    const near = nearestNames(name, all.map((s) => s.name));
    throw new Error(
      ref.word + ": no " + STYLE_TYPE_NOUN[ref.styleType] + " style is named " + JSON.stringify(name) + " in this file's styles or on this page" +
        (ref.id !== undefined ? " (and its id " + JSON.stringify(ref.id) + " is gone)" : "") +
        (near.length ? ". Nearest: " + capped(near.map((n) => JSON.stringify(n))) : "") + ".",
    );
  }

  // The read's style id is the style's key, the one id REST and the plugin share (a plugin id is
  // file-local). Local and page-used styles answer first; importing is how a library style is reached.
  private async styleByKey(key: string): Promise<BaseStyle | null> {
    const known = [...(await this.local()), ...(await this.page()).styles].find((s) => s.key === key);
    if (known) return known;
    return figma.importStyleByKeyAsync(key).catch(() => null);
  }

  private local(): Promise<BaseStyle[]> {
    this.localStyles ??= Promise.all([
      figma.getLocalPaintStylesAsync(), figma.getLocalEffectStylesAsync(), figma.getLocalTextStylesAsync(),
    ]).then((lists) => ([] as BaseStyle[]).concat(...lists));
    return this.localStyles;
  }

  private checkVariableKind(v: Variable, ref: VariableRef): Variable {
    if (v.resolvedType !== ref.resolvedType) throw this.wrongVariableKind(v, ref);
    return v;
  }

  private wrongVariableKind(v: Variable, ref: VariableRef): Error {
    return new Error(ref.word + ": the variable " + JSON.stringify(v.name) + " (id " + v.id + ") is " + v.resolvedType + ", and this word needs a " + ref.resolvedType + " variable.");
  }

  private checkStyleKind(s: BaseStyle, ref: StyleRef): BaseStyle {
    if (s.type !== ref.styleType) throw this.wrongStyleKind(s, ref);
    return s;
  }

  private wrongStyleKind(s: BaseStyle, ref: StyleRef): Error {
    return new Error(ref.word + ": the style " + JSON.stringify(s.name) + " (id " + s.id + ") is a " + s.type + " style, and this word needs a " + ref.styleType + " style.");
  }

  private async describeCandidate(v: Variable): Promise<string> {
    let collection = this.collections.get(v.variableCollectionId);
    if (!collection) this.collections.set(v.variableCollectionId, collection = figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId));
    const c = await collection;
    return JSON.stringify(v.name) + " (collection " + JSON.stringify(c ? c.name : v.variableCollectionId) + ", id " + v.id + ")";
  }

  private page(): Promise<{ variables: Variable[]; styles: BaseStyle[] }> {
    this.pageUsed ??= scanUsedTokens([figma.currentPage]);
    return this.pageUsed;
  }
}

const STYLE_ID_FIELDS = ["fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId", "gridStyleId"] as const;

/**
 * The tokens these pages' nodes are bound to: every alias under `boundVariables` (node fields, text
 * fields, paint and effect slots alike) and every paint's own binding, plus each style slot's id. The
 * pages must already be loaded — the current page always is.
 */
export async function scanUsedTokens(pages: readonly PageNode[]): Promise<{ variables: Variable[]; styles: BaseStyle[] }> {
  const variableIds = new Set<string>();
  const styleIds = new Set<string>();
  const collectAliases = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collectAliases); return; }
    if (!isPlainObject(value)) return;
    if (value.type === "VARIABLE_ALIAS" && typeof value.id === "string") { variableIds.add(value.id); return; }
    Object.values(value).forEach(collectAliases);
  };
  for (const node of pages.flatMap((page) => page.findAll()) as any[]) {
    collectAliases(node.boundVariables);
    for (const slot of ["fills", "strokes"]) {
      const paints = node[slot];
      if (Array.isArray(paints)) for (const paint of paints) collectAliases(paint.boundVariables);
    }
    for (const field of STYLE_ID_FIELDS) {
      const id = node[field];
      if (typeof id === "string" && id) styleIds.add(id);
    }
    // Text whose ranges disagree reads figma.mixed for these; its ranges hold the tokens.
    if (node.type === "TEXT" && [node.textStyleId, node.fillStyleId, node.fills].some((v) => typeof v === "symbol")) {
      for (const segment of node.getStyledTextSegments(["textStyleId", "fillStyleId", "fills", "boundVariables"])) {
        for (const id of [segment.textStyleId, segment.fillStyleId]) if (id) styleIds.add(id);
        collectAliases(segment.boundVariables);
        for (const paint of segment.fills) collectAliases(paint.boundVariables);
      }
    }
  }
  const variables = (await Promise.all([...variableIds].map((id) => figma.variables.getVariableByIdAsync(id)))).filter((v): v is Variable => !!v);
  const styles = (await Promise.all([...styleIds].map((id) => figma.getStyleByIdAsync(id)))).filter((s): s is BaseStyle => !!s);
  return { variables, styles };
}

// Closest names first: an exact case-insensitive hit, then containment either way, then the shortest
// edit distance. Only what the cap would show survives.
function nearestNames(name: string, names: readonly string[]): string[] {
  const want = name.toLowerCase();
  const scored = [...new Set(names)].map((n) => {
    const have = n.toLowerCase();
    const score = have === want ? 0 : have.includes(want) || want.includes(have) ? 1 : 2 + editDistance(want, have);
    return { n, score };
  });
  return scored.sort((a, b) => a.score - b.score).filter((s) => s.score <= Math.max(3, want.length / 2) + 2).map((s) => s.n);
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

async function describeVariable(variable: Variable): Promise<ResolvedVariable> {
  const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
  const defaultMode = collection ? collection.defaultModeId : Object.keys(variable.valuesByMode)[0];
  const literal = (await followAliases(variable.valuesByMode[defaultMode], 0))[0];
  const values: VariableValue[] = [];
  for (const value of Object.values(variable.valuesByMode)) values.push(...(await followAliases(value, 0)));
  return { variable, literal, values };
}

// An alias's target may live in another collection with its own modes, so following one yields every
// value the target can take.
async function followAliases(value: VariableValue, depth: number): Promise<VariableValue[]> {
  if (!isPlainObject(value) || value.type !== "VARIABLE_ALIAS") return [value];
  if (depth > 16) throw new Error("flcm: variable alias chain through " + String(value.id) + " is too deep (a cycle?).");
  const target = await figma.variables.getVariableByIdAsync(value.id as string);
  if (!target) return [];
  const out: VariableValue[] = [];
  for (const v of Object.values(target.valuesByMode)) out.push(...(await followAliases(v, depth + 1)));
  return out;
}

// ---- apply ----

function resolvedVariable(ref: VariableRef, tokens: ResolvedTokens | undefined): ResolvedVariable {
  const hit = tokens?.variables.get(tokenKey(ref));
  if (!hit) throw new Error(ref.word + ": the variable was not resolved before the write. This is an internal error; report it.");
  return hit;
}

export function variableFor(ref: VariableRef, tokens: ResolvedTokens | undefined): Variable {
  return resolvedVariable(ref, tokens).variable;
}

/** What a bound word shows in the default mode — the literal a write lands before (or instead of) binding. */
export function variableLiteral(ref: VariableRef, tokens: ResolvedTokens | undefined): VariableValue {
  return resolvedVariable(ref, tokens).literal;
}

/** Every value a bound word can take across modes. */
export function variableValues(ref: VariableRef, tokens: ResolvedTokens | undefined): readonly VariableValue[] {
  return resolvedVariable(ref, tokens).values;
}

export function styleFor(ref: StyleRef, tokens: ResolvedTokens | undefined): BaseStyle {
  const hit = tokens?.styles.get(tokenKey(ref));
  if (!hit) throw new Error(ref.word + ": the style was not resolved before the write. This is an internal error; report it.");
  return hit;
}

/**
 * Write one node field that a variable may stand in for: bind the variable, or write the literal. A
 * literal over a bound field unbinds it first — the binding would otherwise keep driving the field, and
 * whether a literal write detaches it is not something the plugin API promises for node fields.
 */
export function writeBindable(node: any, field: VariableBindableNodeField | VariableBindableTextField, value: Bindable<unknown>, tokens: ResolvedTokens | undefined): void {
  if (isTokenRef(value)) {
    node.setBoundVariable(field, variableFor(value as VariableRef, tokens));
    return;
  }
  unbindField(node, field);
  node[field] = value;
}

/** Drop a field's binding, if it has one, before a literal write that doesn't go through writeBindable. */
export function unbindField(node: any, field: VariableBindableNodeField | VariableBindableTextField): void {
  const bound = node.boundVariables;
  if (bound && bound[field] && "setBoundVariable" in node) node.setBoundVariable(field, null);
}
