// LOGIN WALK (full leaf fidelity) — the Phase-1 tracer for the flcm rebuild. Exercises the whole spine
// PLUS slice-2's CSS leaves: a linear-gradient background, a radial-gradient corner glow, a card with a
// box-shadow + background-blur (via flcm.effects sugar), rgba/#hex solids, stroke + radius, a numeric
// fontWeight snapped against the Inter ladder, and letterSpacing/lineHeight coercion. Keys -> handles.

const field = (key, label, placeholder) =>
  flcm.frame({ key, layout: { mode: "column", gap: 6 }, width: "fill" }, [
    flcm.text(label, { textStyle: { fontSize: 13, fontWeight: 500 }, color: "rgba(255,255,255,0.7)" }),
    flcm.frame({ layout: { mode: "row", alignItems: "center", padding: { x: 16 } }, width: "fill", height: 48,
                 borderRadius: 12,
                 fill: "rgba(255,255,255,0.06)", stroke: "rgba(255,255,255,0.12)", strokeWidth: 1 }, [
      flcm.text(placeholder, { textStyle: { fontSize: 15 }, color: "rgba(255,255,255,0.4)" }),
    ]),
  ]);

const screen = flcm.frame(
  { key: "login", name: "Login", layout: { mode: "column", gap: 28, padding: 32, alignItems: "stretch" },
    width: 390, height: 844,
    fill: "linear-gradient(180deg, #0B1020 0%, #131A2E 100%)" },
  [
    // Absolute corner affectation — a soft radial glow fading to transparent, lifted out of the flow.
    flcm.ellipse({ name: "Glow", absolute: { x: -80, y: -60 }, width: 180, height: 180,
                   fill: "radial-gradient(circle, #2A3A66 0%, #0B102000 70%)", opacity: 0.6 }),
    flcm.text("Welcome back", { key: "title", color: "#FFFFFF",
                                textStyle: { fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: "32px" } }),
    flcm.frame(
      { key: "card", name: "Card", layout: { mode: "column", gap: 16, padding: 28 }, width: "fill",
        borderRadius: 20,
        fill: "rgba(255,255,255,0.04)", stroke: "rgba(255,255,255,0.08)", strokeWidth: 1,
        effects: flcm.effects({ shadow: { y: 12, blur: 32, color: "rgba(0,0,0,0.18)" }, backgroundBlur: 16 }) },
      [
        field("email", "Email", "you@example.com"),
        field("password", "Password", "••••••••"),
        flcm.frame(
          { key: "submit", name: "Submit", layout: { mode: "row", justifyContent: "center", alignItems: "center" },
            width: "fill", height: 48, borderRadius: 12, fill: "#6366F1" },
          [flcm.text("Sign in", { textStyle: { fontSize: 15, fontWeight: 600 }, color: "#FFFFFF" })],
        ),
      ],
    ),
  ],
);

const out = await flcm.render(screen);

return {
  rootType: out.root.type,
  rootKey: out.root.key,
  keys: Object.keys(out.keyed).sort(),
  cardType: out.keyed.card.type,
  titleText: out.keyed.title.text,
};
