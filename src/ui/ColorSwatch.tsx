import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, radii } from "./theme";

export interface ColorSwatchProps {
  readonly color: string;
  readonly accessibilityLabel: string;
  readonly testID: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}

export function ColorSwatch({
  color,
  accessibilityLabel,
  testID,
  selected,
  onPress,
}: ColorSwatchProps) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.hitArea, pressed && styles.pressed]}
    >
      <View style={[styles.ring, selected && styles.selectedRing]}>
        <View style={[styles.swatch, { backgroundColor: color }]}>
          {selected ? <Text style={styles.check}>✓</Text> : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hitArea: {
    alignItems: "center",
    justifyContent: "center",
    width: 44,
    height: 44,
  },
  pressed: {
    transform: [{ scale: 0.94 }],
  },
  ring: {
    alignItems: "center",
    justifyContent: "center",
    width: 38,
    height: 38,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: "transparent",
  },
  selectedRing: {
    borderColor: colors.accent,
  },
  swatch: {
    alignItems: "center",
    justifyContent: "center",
    width: 30,
    height: 30,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  check: {
    color: colors.ink,
    fontSize: 16,
    lineHeight: 19,
    fontWeight: "700",
    textShadowColor: colors.surface,
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 1,
  },
});
