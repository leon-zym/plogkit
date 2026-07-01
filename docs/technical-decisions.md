# Technical Decisions

## Primary Stack

PlogKit targets iOS and Android with:

- React Native for the application shell and UI.
- Skia for rendering, composition, preview, and export.
- TypeScript for application code.

Skia is the chosen rendering foundation for both platforms.

## Rejected Direction

A native image-composition pipeline is intentionally rejected for now.

Reason:

- It increases platform-specific implementation cost.
- It is less abstract and less reusable across iOS and Android.
- It adds complexity that does not match the current product stage.
- Skia provides a more unified rendering model for text, backgrounds, stitching, and future canvas-like capabilities.

## Package Size Priority

The product is lightweight mainly through feature discipline, not by aggressively minimizing app package size.

App size should still be measured before release, but it is not the primary architectural driver.

## Rendering Model

The app should be document-driven.

The editing state should be represented as serializable data, not as irreversible drawing commands. A simplified document should include:

- Canvas settings.
- Source image references.
- Text elements.
- Border, margin, and background settings.
- Stitching layout settings.
- Export settings.

Runtime objects such as Skia images, gesture state, and animated shared values should not be the persistent source of truth.

## Text Editing

Text rendering can use Skia, but text input should use native text-editing primitives where possible.

Reason:

- Native text input handles cursor behavior, selection, keyboard, IME, and Chinese input better.
- Skia is better suited for final rendering and preview.

Recommended interaction model:

- Use native input for active editing.
- Commit text into the document model.
- Render the final text through Skia.

## Undo And Redo

Undo and redo should operate on document states or document patches.

Initial approach:

- Use a bounded history stack.
- Capture only meaningful committed changes.
- Avoid recording high-frequency intermediate gesture or slider states.

This keeps the implementation practical and avoids excessive memory usage.

## Current Session Persistence

The first persistence target is the current editing session, not a full project library.

Suggested local structure:

```text
projects/
  current/
    document.json
    assets/
      image-1.jpg
      image-2.jpg
    preview.jpg
```

This structure allows future expansion into multiple saved projects without redesigning the data model.

## Image Asset Handling

When images are imported, the app should eventually copy the needed source assets into its own sandbox.

Reason:

- System photo asset references may become unavailable.
- iCloud-backed photos may not always be local.
- Users may delete or modify originals.
- Re-editing requires stable access to source material.

The first implementation can be pragmatic, but the data model should not assume that external asset references are permanent.

## Export

Export should render from the document model, not from a screenshot of the visible preview.

Reason:

- Preview resolution and export resolution may differ.
- Export needs predictable quality.
- Compression presets require deliberate encoding choices.

The app should support a low-cost preview path and a higher-quality export path.

## Future Extension Points

The current architecture should leave room for:

- Freeform canvas.
- Multi-page carousel export.
- Saved style presets.
- Draft list.
- More advanced layer controls.

These should remain future extension points, not first-version requirements.

