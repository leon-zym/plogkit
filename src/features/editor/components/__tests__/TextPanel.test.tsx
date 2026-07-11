import "@/i18n";

import { fireEvent, render, waitFor } from "@testing-library/react-native";

import type { TextElement } from "@/core/document";

import { TextPanel } from "../TextPanel";

describe("TextPanel", () => {
  it("uses distinct visible labels for each text alignment", async () => {
    const view = await render(
      <TextPanel
        elements={[]}
        onDelete={null}
        onPreview={jest.fn()}
        onSelect={jest.fn()}
        onSubmit={jest.fn()}
        selected={null}
      />,
    );

    expect(view.getByText("Align left")).toBeTruthy();
    expect(view.getByText("Align center")).toBeTruthy();
    expect(view.getByText("Align right")).toBeTruthy();
  });

  it("publishes style changes for immediate canvas preview", async () => {
    const onPreview = jest.fn();
    const selected: TextElement = {
      id: "text-1",
      content: "周末的海边日记",
      position: { x: 80, y: 80 },
      width: 840,
      fontId: "system-sans",
      fontSize: 40,
      color: "#FFFFFF",
      alignment: "left",
      lineHeight: 1.35,
      backgroundColor: null,
    };
    const view = await render(
      <TextPanel
        elements={[selected]}
        onDelete={jest.fn()}
        onPreview={onPreview}
        onSelect={jest.fn()}
        onSubmit={jest.fn()}
        selected={selected}
      />,
    );

    fireEvent.press(view.getByTestId("text-preset-headline"));

    await waitFor(() => {
      expect(onPreview).toHaveBeenLastCalledWith(
        expect.objectContaining({ fontSize: 64, lineHeight: 1.1 }),
      );
    });
  });
});
