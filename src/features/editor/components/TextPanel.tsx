import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";

import type { TextAlignment, TextElement } from "@/core/document";
import { ActionButton } from "@/ui/ActionButton";
import { ColorSwatch } from "@/ui/ColorSwatch";
import { OptionRow } from "@/ui/OptionRow";
import { colors, radii, spacing, typography } from "@/ui/theme";

import { PanelShell, panelStyles } from "./PanelShell";

export type TextDraft = Pick<
  TextElement,
  "content" | "fontSize" | "color" | "alignment" | "lineHeight" | "backgroundColor"
>;

const DEFAULT_DRAFT: TextDraft = {
  content: "",
  fontSize: 40,
  color: "#FFFFFF",
  alignment: "left",
  lineHeight: 1.35,
  backgroundColor: null,
};

const TEXT_COLORS = ["#FFFFFF", "#1D1B18", "#D95D3F", "#E8D8BD", "#347A55"] as const;

type TextPresetId = "body" | "headline" | "caption";
type TextPresetValue = TextPresetId | "custom";

const TEXT_PRESETS: Readonly<Record<TextPresetId, Pick<TextDraft, "fontSize" | "lineHeight">>> = {
  body: { fontSize: 40, lineHeight: 1.35 },
  headline: { fontSize: 64, lineHeight: 1.1 },
  caption: { fontSize: 24, lineHeight: 1.3 },
};

export interface TextPanelProps {
  readonly elements: readonly TextElement[];
  readonly selected: TextElement | null;
  readonly onSelect: (id: string | null) => void;
  readonly onSubmit: (draft: TextDraft) => void;
  readonly onDelete: (() => void) | null;
}

export function TextPanel({ elements, selected, onSelect, onSubmit, onDelete }: TextPanelProps) {
  return (
    <TextPanelForm
      elements={elements}
      key={selected?.id ?? "new-text"}
      onDelete={onDelete}
      onSelect={onSelect}
      onSubmit={onSubmit}
      selected={selected}
    />
  );
}

function TextPanelForm({ elements, selected, onSelect, onSubmit, onDelete }: TextPanelProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<TextDraft>(selected ?? DEFAULT_DRAFT);

  const alignmentOptions: readonly {
    value: TextAlignment;
    label: string;
    accessibilityLabel: string;
  }[] = [
    { value: "left", label: "≡", accessibilityLabel: t("text.alignLeft") },
    { value: "center", label: "≡", accessibilityLabel: t("text.alignCenter") },
    { value: "right", label: "≡", accessibilityLabel: t("text.alignRight") },
  ];
  const backgroundOptions = [
    { value: "none", label: t("text.noBackground"), accessibilityLabel: t("text.noBackground") },
    { value: "light", label: "○", accessibilityLabel: t("background.colors.warmWhite") },
    { value: "dark", label: "●", accessibilityLabel: t("background.colors.charcoal") },
  ] as const;
  const presetOptions: readonly {
    value: TextPresetValue;
    label: string;
    accessibilityLabel: string;
  }[] = [
    { value: "body", label: t("text.presets.body"), accessibilityLabel: t("text.presets.body") },
    {
      value: "headline",
      label: t("text.presets.headline"),
      accessibilityLabel: t("text.presets.headline"),
    },
    {
      value: "caption",
      label: t("text.presets.caption"),
      accessibilityLabel: t("text.presets.caption"),
    },
  ];
  const backgroundValue =
    draft.backgroundColor === null
      ? "none"
      : draft.backgroundColor === colors.stage
        ? "dark"
        : "light";

  const adjustFontSize = (delta: number) => {
    setDraft((current) => ({
      ...current,
      fontSize: Math.min(96, Math.max(16, current.fontSize + delta)),
    }));
  };
  const adjustLineHeight = (delta: number) => {
    setDraft((current) => ({
      ...current,
      lineHeight: Math.round(Math.min(2, Math.max(0.9, current.lineHeight + delta)) * 100) / 100,
    }));
  };
  const selectedPreset = Object.entries(TEXT_PRESETS).find(
    ([, preset]) => preset.fontSize === draft.fontSize && preset.lineHeight === draft.lineHeight,
  )?.[0] as TextPresetId | undefined;
  const displayedPresetOptions =
    selectedPreset === undefined
      ? [
          ...presetOptions,
          {
            value: "custom" as const,
            label: t("text.presets.custom"),
            accessibilityLabel: t("text.presets.custom"),
          },
        ]
      : presetOptions;

  return (
    <PanelShell title={selected ? t("text.edit") : t("text.add")}>
      {elements.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.textSelectionRow}>
            <Pressable
              accessibilityLabel={t("text.add")}
              accessibilityRole="button"
              onPress={() => onSelect(null)}
              style={[styles.textSelection, selected === null && styles.selectedTextSelection]}
              testID="select-new-text"
            >
              <Text style={styles.textSelectionLabel}>＋</Text>
            </Pressable>
            {elements.map((element, index) => (
              <Pressable
                accessibilityLabel={`${t("text.edit")} ${index + 1}`}
                accessibilityRole="button"
                accessibilityState={{ selected: selected?.id === element.id }}
                key={element.id}
                onPress={() => onSelect(element.id)}
                style={[
                  styles.textSelection,
                  selected?.id === element.id && styles.selectedTextSelection,
                ]}
                testID={`select-text-${element.id}`}
              >
                <Text numberOfLines={1} style={styles.textSelectionLabel}>
                  {element.content}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      ) : null}
      <TextInput
        accessibilityLabel={t("text.placeholder")}
        maxLength={2000}
        multiline
        onChangeText={(content) => setDraft((current) => ({ ...current, content }))}
        placeholder={t("text.placeholder")}
        placeholderTextColor={colors.inkMuted}
        style={styles.input}
        testID="text-input"
        textAlignVertical="top"
        value={draft.content}
      />
      <View style={panelStyles.section}>
        <Text style={panelStyles.sectionLabel}>{t("text.preset")}</Text>
        <OptionRow
          onChange={(presetId) => {
            if (presetId !== "custom") {
              setDraft((current) => ({ ...current, ...TEXT_PRESETS[presetId] }));
            }
          }}
          options={displayedPresetOptions}
          testIDPrefix="text-preset"
          value={selectedPreset ?? "custom"}
        />
      </View>
      <View style={panelStyles.section}>
        <Text style={panelStyles.sectionLabel}>{t("text.fontSize")}</Text>
        <View style={styles.stepper}>
          <Pressable
            accessibilityLabel={t("common.decrease")}
            accessibilityRole="button"
            onPress={() => adjustFontSize(-4)}
            style={styles.stepButton}
            testID="text-size-decrease"
          >
            <Text style={styles.stepSymbol}>−</Text>
          </Pressable>
          <Text accessibilityLiveRegion="polite" style={styles.sizeValue}>
            {Math.round(draft.fontSize)}
          </Text>
          <Pressable
            accessibilityLabel={t("common.increase")}
            accessibilityRole="button"
            onPress={() => adjustFontSize(4)}
            style={styles.stepButton}
            testID="text-size-increase"
          >
            <Text style={styles.stepSymbol}>+</Text>
          </Pressable>
        </View>
      </View>
      <View style={panelStyles.section}>
        <Text style={panelStyles.sectionLabel}>{t("text.lineHeight")}</Text>
        <View style={styles.stepper}>
          <Pressable
            accessibilityLabel={`${t("text.lineHeight")} ${t("common.decrease")}`}
            accessibilityRole="button"
            onPress={() => adjustLineHeight(-0.05)}
            style={styles.stepButton}
            testID="text-line-height-decrease"
          >
            <Text style={styles.stepSymbol}>−</Text>
          </Pressable>
          <Text accessibilityLiveRegion="polite" style={styles.sizeValue}>
            {draft.lineHeight.toFixed(2)}
          </Text>
          <Pressable
            accessibilityLabel={`${t("text.lineHeight")} ${t("common.increase")}`}
            accessibilityRole="button"
            onPress={() => adjustLineHeight(0.05)}
            style={styles.stepButton}
            testID="text-line-height-increase"
          >
            <Text style={styles.stepSymbol}>+</Text>
          </Pressable>
        </View>
      </View>
      <View style={panelStyles.section}>
        <Text style={panelStyles.sectionLabel}>{t("text.color")}</Text>
        <View accessibilityRole="radiogroup" style={panelStyles.swatches}>
          {TEXT_COLORS.map((color) => (
            <ColorSwatch
              accessibilityLabel={`${t("text.color")} ${color}`}
              color={color}
              key={color}
              onPress={() => setDraft((current) => ({ ...current, color }))}
              selected={draft.color === color}
              testID={`text-color-${color.slice(1).toLowerCase()}`}
            />
          ))}
        </View>
      </View>
      <View style={panelStyles.section}>
        <Text style={panelStyles.sectionLabel}>{t("text.alignment")}</Text>
        <OptionRow
          onChange={(alignment) => setDraft((current) => ({ ...current, alignment }))}
          options={alignmentOptions}
          testIDPrefix="text-alignment"
          value={draft.alignment}
        />
      </View>
      <View style={panelStyles.section}>
        <Text style={panelStyles.sectionLabel}>{t("text.background")}</Text>
        <OptionRow
          onChange={(value) =>
            setDraft((current) => ({
              ...current,
              backgroundColor:
                value === "none" ? null : value === "dark" ? colors.stage : colors.canvasWarm,
            }))
          }
          options={backgroundOptions}
          testIDPrefix="text-background"
          value={backgroundValue}
        />
      </View>
      <View style={styles.actions}>
        {onDelete ? (
          <ActionButton
            accessibilityLabel={t("common.delete")}
            label={t("common.delete")}
            onPress={onDelete}
            testID="delete-text"
            variant="danger"
          />
        ) : null}
        <ActionButton
          accessibilityLabel={t("common.confirm")}
          disabled={draft.content.trim().length === 0 && selected === null}
          label={t("common.confirm")}
          onPress={() => onSubmit({ ...draft, content: draft.content.trim() })}
          testID="commit-text"
        />
      </View>
    </PanelShell>
  );
}

const styles = StyleSheet.create({
  textSelectionRow: {
    flexDirection: "row",
    gap: spacing.s2,
  },
  textSelection: {
    alignItems: "center",
    justifyContent: "center",
    minWidth: 44,
    maxWidth: 144,
    height: 44,
    paddingHorizontal: spacing.s3,
    borderRadius: radii.r12,
    backgroundColor: colors.canvasWarm,
  },
  selectedTextSelection: {
    backgroundColor: colors.accentSoft,
  },
  textSelectionLabel: {
    ...typography.caption,
    color: colors.ink,
  },
  input: {
    minHeight: 104,
    padding: spacing.s3,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.r12,
    backgroundColor: colors.surface,
    color: colors.ink,
    ...typography.body,
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s2,
  },
  stepButton: {
    alignItems: "center",
    justifyContent: "center",
    width: 44,
    height: 44,
    borderRadius: radii.r12,
    backgroundColor: colors.canvasWarm,
  },
  stepSymbol: {
    color: colors.ink,
    fontSize: 24,
    lineHeight: 28,
  },
  sizeValue: {
    ...typography.label,
    color: colors.ink,
    minWidth: 44,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.s2,
  },
});
