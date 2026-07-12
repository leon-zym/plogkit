export const colors = {
  canvasWarm: "#F6F1E8",
  surface: "#FFFCF7",
  stage: "#242321",
  ink: "#1D1B18",
  inkMuted: "#716B62",
  line: "#DED7CC",
  accent: "#D95D3F",
  accentPressed: "#BB472F",
  accentSoft: "#F4D8CF",
  stageText: "#F4F0EA",
  stageMuted: "#B9B2A8",
  danger: "#B93A32",
  success: "#347A55",
} as const;

export const spacing = {
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s6: 24,
  s8: 32,
  s12: 48,
} as const;

export const radii = {
  r4: 4,
  r12: 12,
  r20: 20,
  pill: 999,
} as const;

export const typography = {
  display: { fontSize: 34, lineHeight: 40, fontWeight: "700" as const },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "600" as const },
  body: { fontSize: 16, lineHeight: 25, fontWeight: "400" as const },
  label: { fontSize: 14, lineHeight: 19, fontWeight: "600" as const },
  caption: { fontSize: 12, lineHeight: 17, fontWeight: "500" as const },
} as const;

export const shadows = {
  level1: "0 1px 3px rgba(29, 27, 24, 0.12)",
  level2: "0 8px 24px rgba(29, 27, 24, 0.16)",
} as const;
