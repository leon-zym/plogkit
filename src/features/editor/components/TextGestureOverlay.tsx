import { useCallback, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";

import type { Point, TextElement } from "@/core/document";
import { colors } from "@/ui/theme";

function estimatedTextHeight(text: TextElement): number {
  const averageGlyphWidth = text.fontSize * 0.72;
  const glyphsPerLine = Math.max(1, Math.floor(text.width / averageGlyphWidth));
  const lines = Math.max(1, Math.ceil(text.content.length / glyphsPerLine));
  return lines * text.fontSize * text.lineHeight;
}

interface DraggableTextHitProps {
  readonly text: TextElement;
  readonly scale: number;
  readonly selected: boolean;
  readonly accessibilityLabel: string;
  readonly onSelect: (id: string) => void;
  readonly onCommitPosition: (id: string, position: Point) => void;
}

function DraggableTextHit({
  text,
  scale,
  selected,
  accessibilityLabel,
  onSelect,
  onCommitPosition,
}: DraggableTextHitProps) {
  const translationX = useSharedValue(0);
  const translationY = useSharedValue(0);
  const commit = useCallback(
    (x: number, y: number) => {
      onCommitPosition(text.id, {
        x: text.position.x + x / scale,
        y: text.position.y + y / scale,
      });
    },
    [onCommitPosition, scale, text.id, text.position.x, text.position.y],
  );
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .onBegin(() => runOnJS(onSelect)(text.id))
        .onUpdate((event) => {
          translationX.set(event.translationX);
          translationY.set(event.translationY);
        })
        .onFinalize(() => {
          const x = translationX.get();
          const y = translationY.get();
          translationX.set(0);
          translationY.set(0);
          if (Math.abs(x) >= 1 || Math.abs(y) >= 1) runOnJS(commit)(x, y);
        }),
    [commit, onSelect, text.id, translationX, translationY],
  );
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translationX.get() }, { translateY: translationY.get() }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        style={[
          styles.hit,
          {
            left: text.position.x * scale,
            top: text.position.y * scale,
            width: Math.max(44, text.width * scale),
            height: Math.max(44, estimatedTextHeight(text) * scale),
          },
          animatedStyle,
        ]}
        testID={`canvas-text-${text.id}`}
      >
        {selected ? (
          <>
            <View style={[styles.corner, styles.topLeft]} />
            <View style={[styles.corner, styles.topRight]} />
            <View style={[styles.corner, styles.bottomLeft]} />
            <View style={[styles.corner, styles.bottomRight]} />
          </>
        ) : null}
      </Animated.View>
    </GestureDetector>
  );
}

export interface TextGestureOverlayProps {
  readonly texts: readonly TextElement[];
  readonly canvasWidth: number;
  readonly selectedTextId: string | null;
  readonly accessibilityLabel: (index: number) => string;
  readonly onSelect: (id: string) => void;
  readonly onCommitPosition: (id: string, position: Point) => void;
}

export function TextGestureOverlay({
  texts,
  canvasWidth,
  selectedTextId,
  accessibilityLabel,
  onSelect,
  onCommitPosition,
}: TextGestureOverlayProps) {
  const scale = canvasWidth / 1000;
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {texts.map((text, index) => (
        <DraggableTextHit
          accessibilityLabel={accessibilityLabel(index)}
          key={text.id}
          onCommitPosition={onCommitPosition}
          onSelect={onSelect}
          scale={scale}
          selected={selectedTextId === text.id}
          text={text}
        />
      ))}
    </View>
  );
}

const CORNER_LENGTH = 14;

const styles = StyleSheet.create({
  hit: {
    position: "absolute",
  },
  corner: {
    position: "absolute",
    width: CORNER_LENGTH,
    height: CORNER_LENGTH,
    borderColor: colors.accent,
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 2,
    borderLeftWidth: 2,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: 2,
    borderRightWidth: 2,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 2,
    borderLeftWidth: 2,
  },
  bottomRight: {
    right: 0,
    bottom: 0,
    borderRightWidth: 2,
    borderBottomWidth: 2,
  },
});
