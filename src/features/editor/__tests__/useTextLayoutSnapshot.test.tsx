import type { LineMetrics, SkParagraph } from "@shopify/react-native-skia";
import { renderHook, waitFor } from "@testing-library/react-native";

import type { SceneText } from "@/render/scene";
import { createTextLayoutEnvironment } from "@/render/textLayout";

import { useTextLayoutSnapshot } from "../useTextLayoutSnapshot";

const text = (id: string, fontId = "system-sans"): SceneText => ({
  id,
  content: id,
  x: 20,
  y: 30,
  width: 200,
  fontId,
  fontSize: 24,
  color: "#101010",
  alignment: "left",
  lineHeight: 1.2,
  backgroundColor: null,
});

function metrics(): LineMetrics[] {
  return [
    {
      startIndex: 0,
      endIndex: 1,
      endExcludingWhitespaces: 1,
      endIncludingNewline: 1,
      isHardBreak: false,
      ascent: 18,
      descent: 6,
      height: 24,
      left: 0,
      baseline: 20,
      lineNumber: 0,
      width: 24,
    },
  ];
}

function makeEnvironment() {
  const paragraphs: SkParagraph[] = [];
  const environment = createTextLayoutEnvironment({
    api: {
      Color: (color: string) => color as never,
      ParagraphBuilder: {
        Make: () => ({
          addText: () => undefined,
          build: () => {
            const paragraph = {
              dispose: jest.fn(),
              getHeight: () => 24,
              getLineMetrics: metrics,
              layout: jest.fn(),
              paint: jest.fn(),
            } as unknown as SkParagraph;
            paragraphs.push(paragraph);
            return paragraph;
          },
          dispose: () => undefined,
          pop: () => undefined,
          pushStyle: () => undefined,
        }),
      },
    } as never,
    fontFamilies: { "system-sans": ["Test Sans"] },
    fontProvider: {} as never,
  });
  return { environment, paragraphs };
}

describe("useTextLayoutSnapshot", () => {
  it("commits replacements before disposal, retains the active snapshot on failure, and releases it on unmount", async () => {
    const { environment, paragraphs } = makeEnvironment();
    const firstTexts = [text("first")];
    let renderedTextId: string | null = null;
    const view = await renderHook(
      ({ texts }: { readonly texts: readonly SceneText[] }) => {
        const state = useTextLayoutSnapshot(environment, texts);
        renderedTextId = state.snapshot?.geometry[0]?.id ?? null;
        return state;
      },
      { initialProps: { texts: firstTexts } },
    );

    await waitFor(() => expect(view.result.current.snapshot?.geometry[0]?.id).toBe("first"));
    const firstSnapshot = view.result.current.snapshot;
    const firstParagraph = paragraphs[0];
    expect(firstSnapshot).not.toBeNull();
    expect(firstParagraph).toBeDefined();
    if (firstSnapshot === null || firstParagraph === undefined) return;

    let visibleTextWhenFirstWasDisposed: string | null = null;
    jest.mocked(firstParagraph.dispose).mockImplementation(() => {
      visibleTextWhenFirstWasDisposed = renderedTextId;
    });

    await view.rerender({ texts: [text("second")] });

    await waitFor(() => expect(view.result.current.snapshot?.geometry[0]?.id).toBe("second"));
    expect(firstParagraph.dispose).toHaveBeenCalledTimes(1);
    expect(visibleTextWhenFirstWasDisposed).toBe("second");

    const secondSnapshot = view.result.current.snapshot;
    const secondParagraph = paragraphs[1];
    expect(secondSnapshot).not.toBeNull();
    expect(secondParagraph).toBeDefined();
    if (secondSnapshot === null || secondParagraph === undefined) return;

    await view.rerender({ texts: [text("broken", "missing-font")] });

    await waitFor(() => expect(view.result.current.failure?.code).toBe("font-unavailable"));
    expect(view.result.current.snapshot).toBe(secondSnapshot);
    expect(secondParagraph.dispose).not.toHaveBeenCalled();

    await view.unmount();

    expect(secondParagraph.dispose).toHaveBeenCalledTimes(1);
  });
});
