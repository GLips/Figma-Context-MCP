/*!
 * SPDX-License-Identifier: LicenseRef-Framelink-Commercial
 * See licensing/LICENSE-Framelink-Commercial.md in the distribution root.
 */
// The code samples narrative.ts prints, type-checked against the flcm surface like the worked
// examples. Each `// sample:start <id>` … `// sample:end` region is extracted by `pnpm docs:gen` into
// examples-code.generated.ts (NARRATIVE_SAMPLES), transpiled, so TS-only syntax here — a `NodeSpec`
// annotation that makes a bare spec literal checked, a `!` — never reaches the doc. Not
// Prettier-managed (.prettierignore): the layout is the doc's.
//
// The functions only scope each sample's free names (a live `card`, the sandbox's `session`); nothing
// calls them. Their parameter types are what the samples are checked against.
import type { AuthoredTree, Flcm, NodeSpec } from "@framelink/plugin/schema";

// The slice of the raw plugin API one sample drops to. The root program has no Figma typings, and
// the check that matters here is flcm's.
interface RawFigma {
  getNodeByIdAsync(id: string): Promise<unknown>;
  viewport: { scrollAndZoomIntoView(nodes: unknown[]): void };
}

export async function mentalModelSamples(flcm: Flcm, session: { root: string; screen: AuthoredTree }): Promise<unknown> {
  // sample:start mentalModel
  const template: NodeSpec = { type: "FRAME", layout: { mode: "column", gap: 16 }, children: [
    { type: "TEXT", text: "Hello" }
  ] };
  const first = await flcm.render(template);
  const second = await flcm.render(template);
  // sample:end
  void [first, second];

  async function call1() {
    // sample:start sessionCall1
    // Call 1
    const root = await flcm.render({ type: "FRAME" });
    session.root = root.id;
    const screen: NodeSpec = { type: "FRAME", children: [
      { type: "TEXT", text: "First" }, { type: "TEXT", text: "Second" }
    ] };
    session.screen = await flcm.append(root, screen);
    return session.screen;
    // sample:end
  }

  async function call2() {
    // sample:start sessionCall2
    // Call 2
    session.screen.children!.unshift(session.screen.children!.pop()!);
    session.screen = await flcm.append(session.root, session.screen);
    return session.screen.children!.map(n => n.id);
    // sample:end
  }
  return [call1, call2];
}

export function richTextSamples() {
  // sample:start markdownText
  const message: NodeSpec = { type: "TEXT", text: "Ship it **today** — see the [runbook](https://ex.co/run) first." };
  // sample:end

  // sample:start textRuns
  // a feed caption as ONE node: a colored @handle, plain body, a muted "more"
  const caption: NodeSpec = { type: "TEXT", text: [
    ["@ridgeline", { fontWeight: "semibold", color: "#6366F1" }],
    " summited at golden hour. ",
    ["more", { color: "#8E8E93" }],
  ], textStyle: { fontSize: 14 } };
  // sample:end
  return [message, caption];
}

export function layoutSamples() {
  // sample:start percentTrack
  const track: NodeSpec = { type: "FRAME", width: 300, height: 8, borderRadius: 4, fill: "#E5E7EB", children: [
    { type: "RECTANGLE", width: "35%", height: 8, borderRadius: 4, fill: "#6366F1" }, // 35% of the track
  ] };
  // sample:end

  // sample:start constraints
  // a close button that stays top-right as the card widens
  const card: NodeSpec = { type: "FRAME", width: 320, height: 200, children: [
    { type: "RECTANGLE", width: 28, height: 28, left: 284, top: 12, constraints: { x: "right", y: "top" } },
  ] };
  // sample:end
  return [track, card];
}

export async function vectorSamples(flcm: Flcm) {
  // sample:start vectorForms
  // d: bare geometry. The node's box IS the path's bounding box.
  await flcm.render({ type: "VECTOR", d: "M0 0 L24 24", stroke: "#111", strokeWidth: 2 });
  await flcm.render({ type: "VECTOR", d: "M15 18 L9 12 L15 6", stroke: "#111", scale: 2 }); // same art, twice as big

  // svg: art on the canvas its viewBox declares — and fill/stroke recolor every vector inside it.
  await flcm.render({
    type: "VECTOR",
    svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="red"/></svg>',
    fill: "#6366F1", // recolors the circle, whatever the markup said
    width: 24,
    height: 24,
  });
  // sample:end
}

export function paintSamples(flcm: Flcm) {
  // sample:start paintForms
  const background: NodeSpec = { type: "FRAME", fill: "linear-gradient(180deg, #0B1020 0%, #131A2E 100%)" };
  const sameBackground: NodeSpec = { type: "FRAME", fill: flcm.gradient({ stops: ["#0B1020", "#131A2E"], angle: 180 }) };
  const positional = flcm.gradient("linear", ["#0B1020", "#131A2E"], 180); // (type, stops, angle?)
  // sample:end

  // sample:start paintStack
  const hero: NodeSpec = {
    type: "RECTANGLE", width: 390, height: 260,
    fill: [
      flcm.gradient({ stops: ["rgba(0,0,0,0)", "rgba(0,0,0,0.65)"], angle: 180 }), // the scrim, on top
      flcm.image("https://example.com/photo.jpg"),                                 // the photo, beneath
    ],
  };
  // sample:end
  return [background, sameBackground, positional, hero];
}

export async function tokenSamples(flcm: Flcm, card: string) {
  // sample:start tokenWrites
  await flcm.edit(card, {
    fill: { style: "Surface" },                                  // a paint style takes the whole slot
    stroke: { variable: "Border/Subtle" },                      // a color variable binds one paint layer
    layout: { padding: { variable: "Spacing/16" }, gap: { variable: "Spacing/8" } },
    borderRadius: { variable: "Radius/M" },
  });
  // sample:end

  // sample:start libraryVariables
  const { libraries } = await flcm.designTokens();
  const { variables } = await flcm.designTokens({ library: libraries[0].name, type: "COLOR" });
  return variables.filter((v) => v.collection === "semantic colors");
  // sample:end
}

export function imageSamples(flcm: Flcm) {
  // sample:start imageFills
  const avatar: NodeSpec = { type: "ELLIPSE", width: 48, height: 48, fill: flcm.image("https://example.com/face.jpg") };
  const logo: NodeSpec = { type: "RECTANGLE", width: 120, height: 40, fill: flcm.image("public/logo.png", { scaleMode: "FIT" }) };
  const muted = flcm.image("https://example.com/hero.jpg", { opacity: 0.4, rotation: 90, filters: { saturation: -1 } });
  // sample:end
  return [avatar, logo, muted];
}

export function effectsSamples(flcm: Flcm) {
  // sample:start effectForms
  const frosted: NodeSpec = { type: "FRAME", effects: { boxShadow: "0 12px 32px rgba(0,0,0,0.18)", backdropFilter: "blur(16px)" } };
  const glass: NodeSpec = { type: "FRAME", effects: flcm.effects({ shadow: { y: 12, blur: 32, color: "rgba(0,0,0,0.18)" }, glass: { refraction: 0.4 } }) };
  // sample:end
  return [frosted, glass];
}

export async function rawFigmaSample(flcm: Flcm, figma: RawFigma, screen: NodeSpec) {
  // sample:start rawFigma
  const out = await flcm.render(screen);                     // author with flcm
  const live = await figma.getNodeByIdAsync(out.id);         // drop out for document ops
  figma.viewport.scrollAndZoomIntoView([live]);
  return out.id;
  // sample:end
}

export async function pageSamples(flcm: Flcm) {
  // sample:start pages
  await flcm.page.current();          // { fileName, page: { id, name }, pages: [ … ] } — where am I?
  const { created } = await flcm.page.new("pricing"); // made in the background: the current page stays put
  await flcm.append(created.id, { type: "FRAME", name: "Hero" }); // writes onto the new page, no switch
  await flcm.page.use("pricing");     // switch to one that exists (name or id); never creates
  // sample:end
}

export async function editSamples(flcm: Flcm) {
  // sample:start editMany
  const cards = await flcm.find({ type: "FRAME", name: /^Card$/ });
  await flcm.editMany(cards.map((card) => ({ id: card.id, fill: "#F6F7F9", borderRadius: 12 })));
  // sample:end
}

export async function structureSamples(flcm: Flcm) {
  // sample:start placement
  const panel = await flcm.render({ type: "FRAME", width: 320, height: 200 });
  const label = await flcm.append(panel, { type: "TEXT", text: "Hello" });
  await flcm.prepend(panel, { id: label.id, text: "Moved and edited" });
  // sample:end
}

export async function componentSamples(flcm: Flcm, icon: string, comp: { id: string }, sizeLabelId: string, titleId: string) {
  // sample:start componentProperties
  await flcm.component(
    { type: "FRAME", name: "Row", children: [
      { type: "INSTANCE", componentId: icon, componentPropertyReferences: { componentId: "Icon" } },
      { type: "TEXT", text: "Label", componentPropertyReferences: { text: "Label", visible: "Show Label" } },
      { type: "FRAME", width: 240, height: 80, componentPropertyReferences: { slot: "Content" } },
    ] },
    {
      propertyDefinitions: {
        Icon: { type: "instance_swap" },
        Label: { type: "text" },
        "Show Label": { type: "boolean" },
        Content: { type: "slot" },
      },
    },
  );
  // sample:end

  // sample:start variants
  const small = await flcm.component({ type: "FRAME", width: 96, height: 32 }, { name: "Button" });
  const large = await flcm.component({ type: "FRAME", width: 128, height: 44 }, { name: "Button" });
  const set = await flcm.variants(
    [
      { component: small, variant: { Size: "Small" } },
      { component: large, variant: { Size: "Large" } },
    ],
    { name: "Button" },
  );
  // sample:end
  void set;

  // sample:start propertyDefinitionEdits
  await flcm.edit(comp, {
    propertyDefinitions: {
      Icon: { name: "Leading" },                   // a known name → renames
      Legacy: null,                                //              → deletes
    },
  });
  await flcm.editMany([
    { id: comp.id, propertyDefinitions: { Size: { type: "text" } } },       // a new name → ADDS
    { id: sizeLabelId, componentPropertyReferences: { text: "Size" } },     // …bound in the same batch
  ]);
  // sample:end

  // sample:start bindingEdits
  await flcm.edit(titleId, { componentPropertyReferences: { text: "Heading" } });   // an existing property drives it now
  await flcm.edit(titleId, { componentPropertyReferences: { visible: null } });     // unbind
  // sample:end

  // sample:start boundInserts
  await flcm.append(comp, { type: "TEXT", text: "Save", componentPropertyReferences: { text: "Label" } });   // matches Label's other layers
  await flcm.append(comp, { type: "FRAME", width: 240, height: 80, componentPropertyReferences: { slot: "Content" } });
  // sample:end
}

export async function instanceEditSamples(flcm: Flcm, inst: string, other: { id: string }) {
  // sample:start instanceEdits
  await flcm.edit(inst, { componentProperties: { Size: "Large", Label: "Save" } }); // variant + a text property
  await flcm.edit(inst, { overrides: { "11:9": { fill: "#F00" } }, width: 240 });   // a sublayer, and a root word
  await flcm.edit(inst, { componentId: other.id });                                 // swap the component
  // sample:end
}

export async function annotationSamples(flcm: Flcm, root: string) {
  // sample:start resolveAnnotation
  const [hit] = await flcm.find({ hasAnnotations: true, within: root });
  const task = hit.annotations![0].text;
  // … make the change the note asks for, verify the result, then:
  const fresh = (await flcm.get(hit)).node.annotations ?? [];
  const done = fresh.find((a) => a.text === task);
  if (done) {
    await flcm.edit(hit, { annotations: fresh.filter((a) => a !== done) });
  } // not there any more: leave the node alone and say so in chat
  // sample:end
}
