# Deterministic text-layout fixtures

These modified, test-only font subsets make CanvasKit layout deterministic without depending on
host fonts. They are not shipped as application fonts.

Sources:

- `NotoSans-TestSubset.ttf` comes from
  `https://raw.githubusercontent.com/google/fonts/main/ofl/notosans/NotoSans%5Bwdth%2Cwght%5D.ttf`.
- `NotoSansSC-TestSubset.ttf` comes from
  `https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf`.
- The adjacent `NotoSans-OFL.txt` and `NotoSansSC-OFL.txt` files are the corresponding SIL Open
  Font License 1.1 texts from those official source directories.

The subsets were generated with HarfBuzz `hb-subset`; full source fonts are deliberately not
committed:

```sh
hb-subset NotoSans-full.ttf --text=' AB' --variations='wdth=100,wght=400' --notdef-outline --output-file=NotoSans-TestSubset.ttf
hb-subset NotoSansSC-full.ttf --text='周末的海边日记第一行第二' --variations='wght=400' --notdef-outline --output-file=NotoSansSC-TestSubset.ttf
```

The retained corpus is exactly the Latin primary glyphs `A`, `B`, space and the CJK fallback
glyphs `周末的海边日记第一行第二`. Emoji tests intentionally exercise the retained `.notdef`
outline rather than bundling a color emoji font.

Fixture SHA-256:

- `NotoSans-TestSubset.ttf`:
  `393cfb99b14bb1ae43b1ddcf131a23652e034638498e282c4b43bb4550d343fe`
- `NotoSansSC-TestSubset.ttf`:
  `9833d3cf8a7c8dc673b16aea08f93720edd05c4add5229ff24c96a7a9996fcfd`
