import { fireEvent, render } from "@testing-library/react-native";

import { ActionButton } from "../ActionButton";
import { ColorSwatch } from "../ColorSwatch";
import { ToolButton } from "../ToolButton";

describe("UI controls", () => {
  it("invokes an enabled action button and exposes its accessible name", async () => {
    const onPress = jest.fn();
    const view = await render(
      <ActionButton
        accessibilityLabel="Choose photos"
        label="Choose photos"
        onPress={onPress}
        testID="choose-photos"
      />,
    );

    fireEvent.press(view.getByTestId("choose-photos"));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(view.getByLabelText("Choose photos")).toBeTruthy();
  });

  it("does not invoke a disabled action button", async () => {
    const onPress = jest.fn();
    const view = await render(
      <ActionButton
        accessibilityLabel="Export"
        disabled
        label="Export"
        onPress={onPress}
        testID="export"
      />,
    );

    fireEvent.press(view.getByTestId("export"));

    expect(onPress).not.toHaveBeenCalled();
  });

  it("exposes selected state for tools and color swatches", async () => {
    const view = await render(
      <>
        <ToolButton
          accessibilityLabel="Text tool"
          label="Text"
          onPress={jest.fn()}
          selected
          symbol="Aa"
          testID="tool-text"
        />
        <ColorSwatch
          accessibilityLabel="Warm white"
          color="#F6F1E8"
          onPress={jest.fn()}
          selected
          testID="swatch-warm-white"
        />
      </>,
    );

    expect(view.getByTestId("tool-text")).toHaveProp("accessibilityState", { selected: true });
    expect(view.getByTestId("swatch-warm-white")).toHaveProp("accessibilityState", {
      checked: true,
    });
  });
});
