import "react-native-gesture-handler/jestSetup";

import { act, fireEvent, render } from "@testing-library/react-native";

import { SpacingSlider } from "../SpacingSlider";

interface MockPanGesture {
  readonly onBegin: jest.Mock;
  readonly onUpdate: jest.Mock;
  readonly onEnd: jest.Mock;
}

const mockPanGestures: MockPanGesture[] = [];

jest.mock("react-native-reanimated", () => {
  const ReactNative = jest.requireActual<typeof import("react-native")>("react-native");

  return {
    __esModule: true,
    default: { View: ReactNative.View },
    runOnJS: <Args extends readonly unknown[], Result>(callback: (...args: Args) => Result) =>
      callback,
    useAnimatedStyle: (factory: () => object) => factory(),
    useSharedValue: (initialValue: number) => {
      let value = initialValue;
      return {
        get: () => value,
        set: (nextValue: number) => {
          value = nextValue;
        },
      };
    },
  };
});

jest.mock("react-native-gesture-handler", () => {
  const React = jest.requireActual<typeof import("react")>("react");

  function createMockPanGesture() {
    const gesture: MockPanGesture = {
      onBegin: jest.fn(),
      onUpdate: jest.fn(),
      onEnd: jest.fn(),
    };
    gesture.onBegin.mockReturnValue(gesture);
    gesture.onUpdate.mockReturnValue(gesture);
    gesture.onEnd.mockReturnValue(gesture);
    mockPanGestures.push(gesture);
    return gesture;
  }

  return {
    Gesture: { Pan: createMockPanGesture },
    GestureDetector: ({ children }: { readonly children: import("react").ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

describe("SpacingSlider", () => {
  beforeEach(() => {
    mockPanGestures.length = 0;
  });

  it("[F05-S03] previews every drag value and commits only the value at release", async () => {
    const onPreview = jest.fn();
    const onCommit = jest.fn();
    const view = await render(
      <SpacingSlider
        accessibilityLabel="Spacing"
        onCommit={onCommit}
        onPreview={onPreview}
        testID="spacing"
        value={0}
      />,
    );
    await act(async () => {
      fireEvent(view.getByTestId("spacing"), "layout", {
        nativeEvent: { layout: { width: 228, height: 44, x: 0, y: 0 } },
      });
    });
    const gesture = mockPanGestures.at(-1);
    if (gesture === undefined) throw new Error("expected pan gesture");
    const onBegin = gesture.onBegin.mock.calls.at(-1)?.[0] as (() => void) | undefined;
    const onUpdate = gesture.onUpdate.mock.calls.at(-1)?.[0] as
      ((event: { translationX: number }) => void) | undefined;
    const onEnd = gesture.onEnd.mock.calls.at(-1)?.[0] as (() => void) | undefined;

    onBegin?.();
    onUpdate?.({ translationX: 20 });
    onUpdate?.({ translationX: 80 });

    expect(onPreview).toHaveBeenNthCalledWith(1, 8);
    expect(onPreview).toHaveBeenNthCalledWith(2, 24);
    expect(onCommit).not.toHaveBeenCalled();

    onEnd?.();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(24);
  });
});
