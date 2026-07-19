import { useCallback, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";

import type { Point } from "@/core/document";
import { LOGICAL_CANVAS_WIDTH } from "@/render/scene";
import {
  projectTextLayoutGeometry,
  type ProjectedTextLayoutGeometry,
  type TextLayoutGeometry,
} from "@/render/textLayoutGeometry";
import { colors } from "@/ui/theme";

interface DraggableTextHitProps {
  readonly geometry: TextLayoutGeometry;
  readonly projected: ProjectedTextLayoutGeometry;
  readonly scale: number;
  readonly selected: boolean;
  readonly accessibilityLabel: string;
  readonly onSelect: (id: string) => void;
  readonly onCommitPosition: (id: string, position: Point) => void;
}

function DraggableTextHit({
  geometry,
  projected,
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
      onCommitPosition(geometry.id, {
        x: geometry.placement.x + x / scale,
        y: geometry.placement.y + y / scale,
      });
    },
    [geometry.id, geometry.placement.x, geometry.placement.y, onCommitPosition, scale],
  );
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .onBegin(() => runOnJS(onSelect)(geometry.id))
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
    [commit, geometry.id, onSelect, translationX, translationY],
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
            left: projected.touchBounds.x,
            top: projected.touchBounds.y,
            width: projected.touchBounds.width,
            height: projected.touchBounds.height,
            zIndex: projected.hitPriority,
          },
          animatedStyle,
        ]}
        testID={`canvas-text-${geometry.id}`}
      >
        {selected ? (
          <View
            pointerEvents="none"
            style={[
              styles.selection,
              {
                left: projected.visualBounds.x - projected.touchBounds.x,
                top: projected.visualBounds.y - projected.touchBounds.y,
                width: projected.visualBounds.width,
                height: projected.visualBounds.height,
              },
            ]}
            testID={`canvas-text-selection-${geometry.id}`}
          >
            <View style={[styles.corner, styles.topLeft]} />
            <View style={[styles.corner, styles.topRight]} />
            <View style={[styles.corner, styles.bottomLeft]} />
            <View style={[styles.corner, styles.bottomRight]} />
          </View>
        ) : null}
      </Animated.View>
    </GestureDetector>
  );
}

export interface TextGestureOverlayProps {
  readonly geometry: readonly TextLayoutGeometry[];
  readonly canvasWidth: number;
  readonly selectedTextId: string | null;
  readonly accessibilityLabel: (index: number) => string;
  readonly onSelect: (id: string) => void;
  readonly onCommitPosition: (id: string, position: Point) => void;
}

export function TextGestureOverlay({
  geometry,
  canvasWidth,
  selectedTextId,
  accessibilityLabel,
  onSelect,
  onCommitPosition,
}: TextGestureOverlayProps) {
  const scale = canvasWidth / LOGICAL_CANVAS_WIDTH;
  const projected = useMemo(() => projectTextLayoutGeometry(geometry, scale), [geometry, scale]);
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {projected.map((item, index) => {
        const source = geometry[index];
        if (source === undefined || source.id !== item.id) {
          throw new Error("projected text geometry no longer matches its snapshot");
        }
        return (
          <DraggableTextHit
            accessibilityLabel={accessibilityLabel(index)}
            geometry={source}
            key={item.id}
            onCommitPosition={onCommitPosition}
            onSelect={onSelect}
            projected={item}
            scale={scale}
            selected={selectedTextId === item.id}
          />
        );
      })}
    </View>
  );
}

const CORNER_LENGTH = 14;

const styles = StyleSheet.create({
  hit: {
    position: "absolute",
  },
  selection: {
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
