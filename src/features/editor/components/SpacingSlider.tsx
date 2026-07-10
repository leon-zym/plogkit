import { useCallback, useEffect, useMemo, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";

import { colors, radii, spacing, typography } from "@/ui/theme";

const THUMB_SIZE = 28;

interface SpacingSliderProps {
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly accessibilityLabel: string;
  readonly testID: string;
  readonly onPreview: (value: number) => void;
  readonly onCommit: (value: number) => void;
}

function clamp(value: number, min: number, max: number): number {
  "worklet";
  return Math.min(max, Math.max(min, value));
}

export function SpacingSlider({
  value,
  min = 0,
  max = 64,
  step = 4,
  accessibilityLabel,
  testID,
  onPreview,
  onCommit,
}: SpacingSliderProps) {
  const [trackWidth, setTrackWidth] = useState(0);
  const translateX = useSharedValue(0);
  const startX = useSharedValue(0);

  const valueToX = useCallback(
    (nextValue: number) => ((clamp(nextValue, min, max) - min) / (max - min)) * trackWidth,
    [max, min, trackWidth],
  );
  const xToValue = useCallback(
    (x: number) => {
      if (trackWidth === 0) return min;
      const raw = min + (clamp(x, 0, trackWidth) / trackWidth) * (max - min);
      return clamp(Math.round(raw / step) * step, min, max);
    },
    [max, min, step, trackWidth],
  );

  useEffect(() => {
    translateX.set(valueToX(value));
  }, [translateX, value, valueToX]);

  const previewFromX = useCallback((x: number) => onPreview(xToValue(x)), [onPreview, xToValue]);
  const commitFromX = useCallback((x: number) => onCommit(xToValue(x)), [onCommit, xToValue]);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .onBegin(() => {
          startX.set(translateX.get());
        })
        .onUpdate((event) => {
          translateX.set(clamp(startX.get() + event.translationX, 0, trackWidth));
          runOnJS(previewFromX)(translateX.get());
        })
        .onEnd(() => {
          runOnJS(commitFromX)(translateX.get());
        }),
    [commitFromX, previewFromX, startX, trackWidth, translateX],
  );

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.get() - THUMB_SIZE / 2 }],
  }));

  const onLayout = (event: LayoutChangeEvent) => {
    const width = Math.max(0, event.nativeEvent.layout.width - THUMB_SIZE);
    setTrackWidth(width);
  };

  const adjust = (direction: -1 | 1) => {
    const next = clamp(value + step * direction, min, max);
    onPreview(next);
    onCommit(next);
  };

  const onAccessibilityAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === "increment") adjust(1);
    if (event.nativeEvent.actionName === "decrement") adjust(-1);
  };

  return (
    <View style={styles.row}>
      <GestureDetector gesture={gesture}>
        <Animated.View
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          accessibilityLabel={accessibilityLabel}
          accessibilityRole="adjustable"
          accessibilityValue={{ min, max, now: value, text: `${value}` }}
          onAccessibilityAction={onAccessibilityAction}
          onLayout={onLayout}
          style={styles.hitArea}
          testID={testID}
        >
          <View style={styles.track} />
          <Animated.View style={[styles.thumb, thumbStyle]} />
        </Animated.View>
      </GestureDetector>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s3,
  },
  hitArea: {
    flex: 1,
    height: 44,
    justifyContent: "center",
    paddingHorizontal: THUMB_SIZE / 2,
  },
  track: {
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.line,
  },
  thumb: {
    position: "absolute",
    left: THUMB_SIZE / 2,
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    borderWidth: 3,
    borderColor: colors.surface,
    boxShadow: "0 1px 3px rgba(29, 27, 24, 0.18)",
  },
  value: {
    ...typography.caption,
    color: colors.ink,
    minWidth: 24,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
});
