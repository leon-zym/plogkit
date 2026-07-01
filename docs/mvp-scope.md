# MVP Scope

## First Version Features

The first version includes three editing capabilities plus export and minimal edit-session resilience.

## 1. Add Text To Images

Required capabilities:

- Add text over or around images.
- Support long paragraphs with reasonable line wrapping.
- Provide a small set of clean text styles.
- Support font size, color, alignment, and line height.
- Support text background blocks where useful.

Constraints:

- Do not provide decorative text effects in the first version.
- Do not include sticker-like text assets.
- Do not expose a complex typography system.

## 2. Add Borders And Backgrounds

Required capabilities:

- Add margin or padding around photos.
- Set background color.
- Add simple border treatment.
- Support rounded corners.
- Support common output ratios such as 1:1, 3:4, 4:5, 9:16, and original ratio.

This should feel like a quick task flow, not a layer editor.

## 3. Stitch Multiple Images

Required capabilities:

- Vertical stitching.
- Grid stitching.
- Adjustable spacing.
- Adjustable outer margin.
- Background color.

Constraints:

- Do not expose full freeform layout in the first version.
- Do not require users to manually position every image for common stitching cases.

## 4. Export Compression Presets

Required capabilities:

- Provide several export presets for common social publishing scenarios.
- Support JPEG and PNG where appropriate.
- Make quality and size tradeoffs understandable.

Important product wording:

- Do not promise that presets can prevent social platforms from recompressing uploads.
- The product can optimize export before upload, but the final platform processing remains outside the app's control.

Initial preset direction:

- Original: preserve original dimensions where practical, high quality.
- Social: platform-friendly dimensions and quality.
- Compact: smaller file size for faster sharing.
- Custom: optional later, not mandatory for the first usable version.

## 5. Undo And Redo

Undo and redo are included in the first version.

Reason:

- Text, border, spacing, and stitching adjustments are easy to change accidentally.
- A lightweight app can omit heavy project management, but basic mistake recovery is part of perceived quality.

Implementation principle:

- Record document-state changes at meaningful commit points.
- Do not record every frame during gestures or slider movement.
- Keep a bounded history, for example the latest 30 to 50 steps.

## 6. Auto-Save Current Editing Session

Auto-save of the current editing session is included in the first version.

Required behavior:

- Returning from background should not lose the current edit.
- Accidental exit should not immediately destroy the current project.
- Export should not flatten the only editable copy.

This is not the same as a full draft list.

## 7. Continue Editing After Export

After export, the current project should remain editable in the current session.

Full export history and project management can be postponed.

## Deferred Features

The following are intentionally deferred:

- Full draft list.
- Multi-project management.
- Freeform canvas entry.
- Layer index controls and complex layer UI.
- Opacity controls for arbitrary image layers.
- Template library.
- Brand kits.
- Cloud sync.
- Account system.
- AI editing.
- Video.

## MVP Success Criteria

The first version succeeds if a user can:

- Open the app and select photos quickly.
- Add readable text without fighting the interface.
- Add a clean border or background in a few steps.
- Stitch multiple images into a publishable composition.
- Export a result suitable for social posting.
- Recover from common mistakes through undo or automatic session recovery.

