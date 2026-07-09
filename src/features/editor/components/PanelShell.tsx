import type { PropsWithChildren } from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors, spacing, typography } from "@/ui/theme";

interface PanelShellProps extends PropsWithChildren {
  readonly title: string;
}

export function PanelShell({ title, children }: PanelShellProps) {
  return (
    <View style={styles.root} testID="editor-tool-panel">
      <Text style={styles.title}>{title}</Text>
      {children}
    </View>
  );
}

export const panelStyles = StyleSheet.create({
  section: {
    gap: spacing.s2,
  },
  sectionLabel: {
    ...typography.caption,
    color: colors.inkMuted,
  },
  swatches: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.s2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.s3,
  },
});

const styles = StyleSheet.create({
  root: {
    gap: spacing.s4,
    paddingHorizontal: spacing.s4,
    paddingTop: spacing.s4,
    paddingBottom: spacing.s6,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  title: {
    ...typography.title,
    color: colors.ink,
  },
});
