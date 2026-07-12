import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";

import { ToolButton } from "@/ui/ToolButton";
import { colors } from "@/ui/theme";

export type EditorTool = "background" | "stitch" | "text";

export interface EditorToolbarProps {
  readonly activeTool: EditorTool;
  readonly onToolChange: (tool: EditorTool) => void;
}

export function EditorToolbar({ activeTool, onToolChange }: EditorToolbarProps) {
  const { t } = useTranslation();
  const tools = [
    { id: "background" as const, symbol: "□", label: t("editor.tools.background") },
    { id: "stitch" as const, symbol: "▦", label: t("editor.tools.stitch") },
    { id: "text" as const, symbol: "Aa", label: t("editor.tools.text") },
  ];
  return (
    <View accessibilityRole="tablist" style={styles.root}>
      {tools.map((tool) => (
        <ToolButton
          accessibilityLabel={tool.label}
          key={tool.id}
          label={tool.label}
          onPress={() => onToolChange(tool.id)}
          selected={activeTool === tool.id}
          symbol={tool.symbol}
          testID={`editor-tool-${tool.id}`}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: "row",
    justifyContent: "space-around",
    backgroundColor: colors.surface,
  },
});
