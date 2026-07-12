import { makeSceneParagraph } from "../skiaDraw";
import type { SceneText } from "../scene";

const TEXT: SceneText = {
  id: "text-1",
  content: "Morning note",
  x: 80,
  y: 80,
  width: 840,
  fontId: "system-sans",
  fontSize: 64,
  color: "#FFFFFF",
  alignment: "center",
  lineHeight: 1.1,
  backgroundColor: null,
};

function makeApi() {
  const paragraph = { layout: jest.fn() };
  const builder = {
    addText: jest.fn(),
    build: jest.fn(() => paragraph),
  };
  const api = {
    Color: jest.fn((value: string) => value),
    FontMgr: { System: jest.fn(() => ({ kind: "system-fonts" })) },
    ParagraphBuilder: { Make: jest.fn(() => builder) },
  } as unknown as Parameters<typeof makeSceneParagraph>[0];
  return { api, builder, paragraph };
}

describe("makeSceneParagraph", () => {
  it("omits a null background and supports native builders without dispose", () => {
    const { api, builder, paragraph } = makeApi();

    const result = makeSceneParagraph(api, TEXT);

    expect(result).toBe(paragraph);
    expect(api.ParagraphBuilder.Make).toHaveBeenCalledWith(
      expect.objectContaining({
        textStyle: expect.not.objectContaining({ backgroundColor: expect.anything() }),
      }),
      { kind: "system-fonts" },
    );
    expect(builder.addText).toHaveBeenCalledWith("Morning note");
    expect(paragraph.layout).toHaveBeenCalledWith(840);
  });

  it("converts and includes a selected text background color", () => {
    const { api } = makeApi();

    makeSceneParagraph(api, { ...TEXT, backgroundColor: "#1D1B18" });

    expect(api.ParagraphBuilder.Make).toHaveBeenCalledWith(
      expect.objectContaining({
        textStyle: expect.objectContaining({ backgroundColor: "#1D1B18" }),
      }),
      expect.anything(),
    );
  });
});
