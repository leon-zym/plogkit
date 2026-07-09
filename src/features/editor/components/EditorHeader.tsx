import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

import { colors, spacing, typography } from "@/ui/theme";

interface HeaderButtonProps {
  readonly label: string;
  readonly symbol: string;
  readonly testID: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}

function HeaderButton({ label, symbol, testID, disabled = false, onPress }: HeaderButtonProps) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.headerButton,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      <Text style={styles.headerSymbol}>{symbol}</Text>
    </Pressable>
  );
}

export interface EditorHeaderProps {
  readonly imageCount: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onBack: () => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onExport: () => void;
}

export function EditorHeader({
  imageCount,
  canUndo,
  canRedo,
  onBack,
  onUndo,
  onRedo,
  onExport,
}: EditorHeaderProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.root}>
      <HeaderButton label={t("common.back")} onPress={onBack} symbol="‹" testID="editor-back" />
      <Text style={styles.count}>{t("editor.photoCount", { count: imageCount })}</Text>
      <View style={styles.actions}>
        <HeaderButton
          disabled={!canUndo}
          label={t("editor.undo")}
          onPress={onUndo}
          symbol="↶"
          testID="editor-undo"
        />
        <HeaderButton
          disabled={!canRedo}
          label={t("editor.redo")}
          onPress={onRedo}
          symbol="↷"
          testID="editor-redo"
        />
        <Pressable
          accessibilityLabel={t("editor.export")}
          accessibilityRole="button"
          onPress={onExport}
          style={({ pressed }) => [styles.export, pressed && styles.pressed]}
          testID="editor-open-export"
        >
          <Text style={styles.exportLabel}>{t("editor.export")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 52,
    paddingHorizontal: spacing.s2,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  headerButton: {
    alignItems: "center",
    justifyContent: "center",
    width: 44,
    height: 44,
  },
  headerSymbol: {
    color: colors.ink,
    fontSize: 24,
    lineHeight: 28,
  },
  count: {
    ...typography.caption,
    color: colors.inkMuted,
    flex: 1,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
  },
  export: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: spacing.s2,
  },
  exportLabel: {
    ...typography.label,
    color: colors.accent,
  },
  pressed: {
    transform: [{ scale: 0.96 }],
    opacity: 0.72,
  },
  disabled: {
    opacity: 0.3,
  },
});
