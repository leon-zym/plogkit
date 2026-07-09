import { Pressable, StyleSheet, Text, type PressableProps } from "react-native";

import { colors, radii, spacing, typography } from "./theme";

type ActionButtonVariant = "primary" | "secondary" | "danger";

export interface ActionButtonProps {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly testID: string;
  readonly onPress: NonNullable<PressableProps["onPress"]>;
  readonly disabled?: boolean;
  readonly variant?: ActionButtonVariant;
}

export function ActionButton({
  label,
  accessibilityLabel,
  testID,
  onPress,
  disabled = false,
  variant = "primary",
}: ActionButtonProps) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        variant === "primary" && styles.primary,
        variant === "secondary" && styles.secondary,
        variant === "danger" && styles.danger,
        pressed && !disabled && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text
        style={[
          styles.label,
          variant === "primary" && styles.primaryLabel,
          variant === "secondary" && styles.secondaryLabel,
          variant === "danger" && styles.dangerLabel,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: spacing.s6,
    borderRadius: radii.r12,
  },
  primary: {
    backgroundColor: colors.accent,
  },
  secondary: {
    backgroundColor: "transparent",
  },
  danger: {
    backgroundColor: "transparent",
  },
  pressed: {
    transform: [{ scale: 0.97 }],
    opacity: 0.88,
  },
  disabled: {
    opacity: 0.38,
  },
  label: {
    ...typography.label,
    textAlign: "center",
  },
  primaryLabel: {
    color: colors.surface,
  },
  secondaryLabel: {
    color: colors.ink,
  },
  dangerLabel: {
    color: colors.danger,
  },
});
