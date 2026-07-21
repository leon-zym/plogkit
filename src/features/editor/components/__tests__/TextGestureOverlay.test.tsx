import "react-native-gesture-handler/jestSetup";

import { render } from "@testing-library/react-native";

import type { TextLayoutGeometry } from "@/render/textLayoutGeometry";

import { TextGestureOverlay } from "../TextGestureOverlay";

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
    const mockGesture = {
      minDistance: jest.fn(),
      onBegin: jest.fn(),
      onUpdate: jest.fn(),
      onFinalize: jest.fn(),
    };
    mockGesture.minDistance.mockReturnValue(mockGesture);
    mockGesture.onBegin.mockReturnValue(mockGesture);
    mockGesture.onUpdate.mockReturnValue(mockGesture);
    mockGesture.onFinalize.mockReturnValue(mockGesture);
    return mockGesture;
  }

  return {
    Gesture: { Pan: createMockPanGesture },
    GestureDetector: ({ children }: { readonly children: import("react").ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

const geometry = (id: string): TextLayoutGeometry => ({
  id,
  placement: { x: 100, y: 200 },
  localVisualBounds: { x: 4, y: 6, width: 20, height: 10 },
});

describe("TextGestureOverlay", () => {
  it("renders touch bounds separately from the selection box and puts later text on top", async () => {
    const view = await render(
      <TextGestureOverlay
        accessibilityLabel={(index) => `Edit text ${index + 1}`}
        canvasWidth={500}
        geometry={[geometry("lower"), geometry("upper")]}
        onCommitPosition={jest.fn()}
        onSelect={jest.fn()}
        selectedTextId="lower"
      />,
    );

    expect(view.getByTestId("canvas-text-hit-0-lower")).toHaveStyle({
      left: 35,
      top: 83.5,
      width: 44,
      height: 44,
      zIndex: 0,
    });
    expect(view.getByTestId("canvas-text-selection-lower")).toHaveStyle({
      left: 17,
      top: 19.5,
      width: 10,
      height: 5,
    });
    expect(view.getByTestId("canvas-text-hit-1-upper")).toHaveStyle({ zIndex: 1 });
  });
});
