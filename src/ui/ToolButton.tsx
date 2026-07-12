import { Pressable, StyleSheet, Text } from "react-native";

import { colors, spacing, typography } from "./theme";

export interface ToolButtonProps {
  readonly label: string;
  readonly symbol: string;
  readonly accessibilityLabel: string;
  readonly testID: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}

export function ToolButton({
  label,
  symbol,
  accessibilityLabel,
  testID,
  selected,
  onPress,
}: ToolButtonProps) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.root, pressed && styles.pressed]}
    >
      <Text style={[styles.symbol, selected && styles.selectedText]}>{symbol}</Text>
      <Text style={[styles.label, selected && styles.selectedText]} numberOfLines={2}>
        {label}
      </Text>
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.marker}
      >
        {selected ? "━" : " "}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 56,
    minWidth: 64,
    paddingHorizontal: spacing.s2,
    paddingTop: spacing.s1,
  },
  pressed: {
    transform: [{ scale: 0.97 }],
    opacity: 0.72,
  },
  symbol: {
    color: colors.inkMuted,
    fontSize: 18,
    lineHeight: 21,
    fontWeight: "600",
  },
  label: {
    ...typography.caption,
    color: colors.inkMuted,
    textAlign: "center",
  },
  selectedText: {
    color: colors.accent,
  },
  marker: {
    color: colors.accent,
    fontSize: 14,
    lineHeight: 10,
    height: 10,
  },
});
