import "@/i18n";

import { render } from "@testing-library/react-native";

import { BackgroundPanel } from "../BackgroundPanel";

describe("BackgroundPanel", () => {
  it("renders complete aspect-ratio labels without treating colons as namespaces", async () => {
    const view = await render(
      <BackgroundPanel
        backgroundColor="#FFFFFF"
        onBackgroundColorChange={jest.fn()}
        onRatioChange={jest.fn()}
        ratio="original"
      />,
    );

    expect(view.getByText("1:1")).toBeTruthy();
    expect(view.getByText("3:4")).toBeTruthy();
    expect(view.getByText("4:5")).toBeTruthy();
    expect(view.getByText("9:16")).toBeTruthy();
  });
});
