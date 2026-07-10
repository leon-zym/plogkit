import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

import { CANVAS_RATIOS, type CanvasRatio } from "@/core/document";
import { ColorSwatch } from "@/ui/ColorSwatch";
import { OptionRow } from "@/ui/OptionRow";
import { spacing } from "@/ui/theme";

import { PanelShell, panelStyles } from "./PanelShell";

const BACKGROUND_COLORS = [
  { value: "#F6F1E8", labelKey: "background.colors.warmWhite" },
  { value: "#FFFFFF", labelKey: "background.colors.white" },
  { value: "#242321", labelKey: "background.colors.charcoal" },
  { value: "#E8D8BD", labelKey: "background.colors.sand" },
  { value: "#E7C8C4", labelKey: "background.colors.rose" },
  { value: "#C9D3C2", labelKey: "background.colors.sage" },
] as const;

const RATIO_LABEL_KEYS: Readonly<Record<CanvasRatio, string>> = {
  original: "background.ratios.original",
  "1:1": "background.ratios.square",
  "3:4": "background.ratios.portrait3x4",
  "4:5": "background.ratios.portrait4x5",
  "9:16": "background.ratios.story",
};

export interface BackgroundPanelProps {
  readonly ratio: CanvasRatio;
  readonly backgroundColor: string;
  readonly onRatioChange: (ratio: CanvasRatio) => void;
  readonly onBackgroundColorChange: (color: string) => void;
}

export function BackgroundPanel({
  ratio,
  backgroundColor,
  onRatioChange,
  onBackgroundColorChange,
}: BackgroundPanelProps) {
  const { t } = useTranslation();
  const ratioOptions = CANVAS_RATIOS.map((value) => ({
    value,
    label: t(RATIO_LABEL_KEYS[value]),
    accessibilityLabel: t(RATIO_LABEL_KEYS[value]),
  }));

  return (
    <PanelShell title={t("background.title")}>
      <View style={panelStyles.section}>
        <Text style={panelStyles.sectionLabel}>{t("background.color")}</Text>
        <View accessibilityRole="radiogroup" style={styles.swatches}>
          {BACKGROUND_COLORS.map((option) => (
            <ColorSwatch
              accessibilityLabel={t(option.labelKey)}
              color={option.value}
              key={option.value}
              onPress={() => onBackgroundColorChange(option.value)}
              selected={backgroundColor.toUpperCase() === option.value}
              testID={`background-color-${option.value.slice(1).toLowerCase()}`}
            />
          ))}
        </View>
      </View>
      <View style={panelStyles.section}>
        <Text style={panelStyles.sectionLabel}>{t("background.ratio")}</Text>
        <OptionRow
          onChange={onRatioChange}
          options={ratioOptions}
          testIDPrefix="canvas-ratio"
          value={ratio}
        />
      </View>
    </PanelShell>
  );
}

const styles = StyleSheet.create({
  swatches: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.s2,
    minHeight: 44,
  },
});
