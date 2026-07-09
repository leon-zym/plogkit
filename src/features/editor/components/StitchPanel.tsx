import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

import type { SourceImage, StitchMode } from "@/core/document";
import { OptionRow } from "@/ui/OptionRow";
import { colors, radii, spacing, typography } from "@/ui/theme";

import { PanelShell, panelStyles } from "./PanelShell";
import { SpacingSlider } from "./SpacingSlider";

export interface StitchPanelProps {
  readonly images: readonly SourceImage[];
  readonly order: readonly string[];
  readonly mode: StitchMode;
  readonly spacingValue: number;
  readonly onModeChange: (mode: StitchMode) => void;
  readonly onSpacingPreview: (value: number) => void;
  readonly onSpacingCommit: (value: number) => void;
  readonly onOrderChange: (order: readonly string[]) => void;
}

export function StitchPanel({
  images,
  order,
  mode,
  spacingValue,
  onModeChange,
  onSpacingPreview,
  onSpacingCommit,
  onOrderChange,
}: StitchPanelProps) {
  const { t } = useTranslation();
  const byId = new Map(images.map((image) => [image.id, image]));
  const modeOptions = [
    {
      value: "vertical" as const,
      label: t("stitch.vertical"),
      accessibilityLabel: t("stitch.vertical"),
    },
    { value: "grid" as const, label: t("stitch.grid"), accessibilityLabel: t("stitch.grid") },
  ];

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onOrderChange(next);
  };

  return (
    <PanelShell title={t("stitch.title")}>
      <View style={panelStyles.section}>
        <Text style={panelStyles.sectionLabel}>{t("stitch.layout")}</Text>
        <OptionRow
          onChange={onModeChange}
          options={modeOptions}
          testIDPrefix="stitch-mode"
          value={mode}
        />
      </View>
      <View style={panelStyles.section}>
        <Text style={panelStyles.sectionLabel}>{t("stitch.spacing")}</Text>
        <SpacingSlider
          accessibilityLabel={t("stitch.spacing")}
          onCommit={onSpacingCommit}
          onPreview={onSpacingPreview}
          testID="stitch-spacing"
          value={spacingValue}
        />
      </View>
      {order.length > 1 ? (
        <View style={panelStyles.section}>
          <Text style={panelStyles.sectionLabel}>{t("stitch.order")}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.orderRow}>
              {order.map((imageId, index) => (
                <View key={imageId} style={styles.orderItem}>
                  <Text style={styles.orderNumber}>{index + 1}</Text>
                  <Text numberOfLines={1} style={styles.imageName}>
                    {byId.get(imageId)?.id ?? imageId}
                  </Text>
                  <View style={styles.orderActions}>
                    <Pressable
                      accessibilityLabel={`${t("stitch.moveEarlier")} ${index + 1}`}
                      accessibilityRole="button"
                      disabled={index === 0}
                      onPress={() => move(index, -1)}
                      style={styles.orderButton}
                      testID={`image-order-earlier-${imageId}`}
                    >
                      <Text style={[styles.arrow, index === 0 && styles.disabled]}>‹</Text>
                    </Pressable>
                    <Pressable
                      accessibilityLabel={`${t("stitch.moveLater")} ${index + 1}`}
                      accessibilityRole="button"
                      disabled={index === order.length - 1}
                      onPress={() => move(index, 1)}
                      style={styles.orderButton}
                      testID={`image-order-later-${imageId}`}
                    >
                      <Text style={[styles.arrow, index === order.length - 1 && styles.disabled]}>
                        ›
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      ) : null}
    </PanelShell>
  );
}

const styles = StyleSheet.create({
  orderRow: {
    flexDirection: "row",
    gap: spacing.s2,
  },
  orderItem: {
    width: 112,
    minHeight: 72,
    padding: spacing.s2,
    borderRadius: radii.r12,
    backgroundColor: colors.canvasWarm,
  },
  orderNumber: {
    ...typography.caption,
    color: colors.accent,
  },
  imageName: {
    ...typography.caption,
    color: colors.ink,
  },
  orderActions: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  orderButton: {
    alignItems: "center",
    justifyContent: "center",
    width: 40,
    height: 40,
  },
  arrow: {
    color: colors.ink,
    fontSize: 26,
    lineHeight: 30,
  },
  disabled: {
    opacity: 0.25,
  },
});
