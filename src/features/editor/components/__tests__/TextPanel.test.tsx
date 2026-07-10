import "@/i18n";

import { render } from "@testing-library/react-native";

import { TextPanel } from "../TextPanel";

describe("TextPanel", () => {
  it("uses distinct visible labels for each text alignment", async () => {
    const view = await render(
      <TextPanel
        elements={[]}
        onDelete={null}
        onSelect={jest.fn()}
        onSubmit={jest.fn()}
        selected={null}
      />,
    );

    expect(view.getByText("Align left")).toBeTruthy();
    expect(view.getByText("Align center")).toBeTruthy();
    expect(view.getByText("Align right")).toBeTruthy();
  });
});
