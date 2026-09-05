import type { Flcm } from "@framelink/plugin/schema";

// The login-screen worked example. Authored against the REAL typed surface (Flcm), so a schema change
// that renames/removes a prop or moves a signature breaks this file's typecheck — the build goes red
// rather than the docs shipping a stale example. The generator inlines only the marked region below
// (dedented); the async wrapper and this import are stripped. See examples.ts for the marker constants —
// and for the agent-facing description of what this example demonstrates (kept there, not duplicated).
export async function loginExample(flcm: Flcm) {
  // example:start
  const fields = [
    { key: "email", label: "Email", placeholder: "you@example.com" },
    { key: "password", label: "Password", placeholder: "••••••••" },
  ].map(({ key, label, placeholder }) =>
    flcm.frame({ key, layout: { mode: "column", gap: 6 }, width: "fill" }, [
      flcm.text(label, {
        textStyle: { fontSize: 13, fontWeight: 500 },
        fill: "rgba(255,255,255,0.7)",
      }),
      flcm.frame(
        {
          layout: { mode: "row", alignItems: "center", padding: { x: 16 } },
          width: "fill",
          height: 48,
          borderRadius: 12,
          fill: "rgba(255,255,255,0.06)",
          stroke: "rgba(255,255,255,0.12)",
          strokeWidth: 1,
        },
        [flcm.text(placeholder, { textStyle: { fontSize: 15 }, fill: "rgba(255,255,255,0.4)" })],
      ),
    ]),
  );

  const screen = flcm.frame(
    {
      key: "login",
      name: "Login",
      layout: { mode: "column", gap: 28, padding: 32 },
      width: 390,
      height: 844,
      fill: "linear-gradient(180deg, #0B1020 0%, #131A2E 100%)",
    },
    [
      // Declared first → sits behind everything. `left`/`top` lift it out of the column flow.
      flcm.ellipse({
        name: "Glow",
        left: -80,
        top: -60,
        width: 180,
        height: 180,
        fill: "radial-gradient(circle, #2A3A66 0%, #0B102000 70%)",
        opacity: 0.6,
      }),
      flcm.text("Welcome back", {
        key: "title",
        fill: "#FFFFFF",
        textStyle: { fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: "32px" },
      }),
      flcm.frame(
        {
          key: "card",
          name: "Card",
          layout: { mode: "column", gap: 16, padding: 28 },
          width: "fill",
          borderRadius: 20,
          fill: "rgba(255,255,255,0.04)",
          stroke: "rgba(255,255,255,0.08)",
          strokeWidth: 1,
          effects: { boxShadow: "0 12px 32px rgba(0,0,0,0.18)", backdropFilter: "blur(8px)" },
        },
        [
          ...fields,
          flcm.frame(
            {
              key: "submit",
              name: "Submit",
              layout: { mode: "row", justifyContent: "center", alignItems: "center" },
              width: "fill",
              height: 48,
              borderRadius: 12,
              fill: "#6366F1",
            },
            [
              flcm.text("Sign in", {
                textStyle: { fontSize: 15, fontWeight: 600 },
                fill: "#FFFFFF",
              }),
            ],
          ),
        ],
      ),
    ],
  );

  const out = await flcm.render(screen);

  return {
    node: out.node.id, // the login frame's id
    card: out.keyed.card.id, // a keyed node, addressed after render
    title: out.keyed.title.text, // "Welcome back"
  };
  // example:end
}
