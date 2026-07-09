import { Pressable, ScrollView, StyleSheet, Text } from "react-native";

import { colors, radii, spacing, typography } from "./theme";

export interface OptionRowItem<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly accessibilityLabel: string;
}

export interface OptionRowProps<T extends string> {
  readonly options: readonly OptionRowItem<T>[];
  readonly value: T;
  readonly testIDPrefix: string;
  readonly onChange: (value: T) => void;
}

export function OptionRow<T extends string>({
  options,
  value,
  testIDPrefix,
  onChange,
}: OptionRowProps<T>) {
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      horizontal
      showsHorizontalScrollIndicator={false}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            accessibilityLabel={option.accessibilityLabel}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            key={option.value}
            onPress={() => onChange(option.value)}
            testID={`${testIDPrefix}-${option.value}`}
            style={({ pressed }) => [
              styles.option,
              selected && styles.selectedOption,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.label, selected && styles.selectedLabel]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.s2,
  },
  option: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    minWidth: 52,
    paddingHorizontal: spacing.s3,
    borderRadius: radii.r12,
    backgroundColor: colors.canvasWarm,
  },
  selectedOption: {
    backgroundColor: colors.accentSoft,
  },
  pressed: {
    transform: [{ scale: 0.97 }],
    opacity: 0.78,
  },
  label: {
    ...typography.label,
    color: colors.inkMuted,
  },
  selectedLabel: {
    color: colors.ink,
  },
});
