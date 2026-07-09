import { StyleSheet, Switch, Text, View } from "react-native";
import { useTranslation } from "react-i18next";

import type { ExportFormat, ExportPresetId, ExportSettings } from "@/core/document";
import { ActionButton } from "@/ui/ActionButton";
import { OptionRow } from "@/ui/OptionRow";
import { colors, radii, spacing, typography } from "@/ui/theme";

import { PanelShell, panelStyles } from "./PanelShell";

export type ExportStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "exporting" }
  | {
      readonly kind: "success";
      readonly width: number;
      readonly height: number;
      readonly wasReduced: boolean;
    }
  | { readonly kind: "error" };

export interface ExportPanelProps {
  readonly settings: ExportSettings;
  readonly status: ExportStatus;
  readonly onSettingsChange: (settings: ExportSettings) => void;
  readonly onExport: () => void;
}

export function ExportPanel({ settings, status, onSettingsChange, onExport }: ExportPanelProps) {
  const { t } = useTranslation();
  const presetOptions: readonly {
    value: ExportPresetId;
    label: string;
    accessibilityLabel: string;
  }[] = (["original", "social", "compact"] as const).map((value) => ({
    value,
    label: t(`export.presets.${value}`),
    accessibilityLabel: t(`export.presets.${value}`),
  }));
  const formatOptions: readonly {
    value: ExportFormat;
    label: string;
    accessibilityLabel: string;
  }[] = [
    { value: "jpeg", label: "JPEG", accessibilityLabel: "JPEG" },
    { value: "png", label: "PNG", accessibilityLabel: "PNG" },
  ];
  const canRetainBasic = settings.format === "jpeg";
  const retainBasic = canRetainBasic && settings.metadataPolicy === "retain-basic";

  const update = (next: Partial<ExportSettings>) => {
    const merged = { ...settings, ...next };
    onSettingsChange({
      ...merged,
      metadataPolicy: merged.format === "png" ? "strip" : merged.metadataPolicy,
    });
  };

  return (
    <PanelShell title={t("export.title")}>
      <View style={panelStyles.section}>
        <Text style={panelStyles.sectionLabel}>{t("export.preset")}</Text>
        <OptionRow
          onChange={(presetId) => update({ presetId })}
          options={presetOptions}
          testIDPrefix="export-preset"
          value={settings.presetId}
        />
      </View>
      <View style={panelStyles.section}>
        <Text style={panelStyles.sectionLabel}>{t("export.format")}</Text>
        <OptionRow
          onChange={(format) => update({ format })}
          options={formatOptions}
          testIDPrefix="export-format"
          value={settings.format}
        />
      </View>
      <View style={styles.privacyRow}>
        <View style={styles.privacyCopy}>
          <Text style={styles.privacyTitle}>{t("export.retainBasic")}</Text>
          <Text style={styles.privacyBody}>
            {canRetainBasic ? t("export.sRGBNotice") : t("export.retainUnavailablePng")}
          </Text>
        </View>
        <Switch
          accessibilityLabel={t("export.retainBasic")}
          disabled={!canRetainBasic}
          onValueChange={(enabled) =>
            update({ metadataPolicy: enabled ? "retain-basic" : "strip" })
          }
          testID="export-retain-basic"
          thumbColor={colors.surface}
          trackColor={{ false: colors.line, true: colors.accent }}
          value={retainBasic}
        />
      </View>
      {status.kind === "success" ? (
        <View accessibilityLiveRegion="polite" style={styles.success} testID="export-success">
          <Text style={styles.successTitle}>{t("export.success")}</Text>
          {status.wasReduced ? (
            <Text style={styles.successDetail}>
              {t("export.reduced", { width: status.width, height: status.height })}
            </Text>
          ) : (
            <Text style={styles.successDetail}>
              {settings.format.toUpperCase()} · {status.width} × {status.height}
            </Text>
          )}
        </View>
      ) : null}
      {status.kind === "error" ? (
        <Text accessibilityLiveRegion="assertive" style={styles.error} testID="export-error">
          {t("export.failure")}
        </Text>
      ) : null}
      <ActionButton
        accessibilityLabel={t("export.action")}
        disabled={status.kind === "exporting"}
        label={status.kind === "exporting" ? t("export.exporting") : t("export.action")}
        onPress={onExport}
        testID="export-document"
      />
    </PanelShell>
  );
}

const styles = StyleSheet.create({
  privacyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.s4,
  },
  privacyCopy: {
    flex: 1,
    gap: spacing.s1,
  },
  privacyTitle: {
    ...typography.label,
    color: colors.ink,
  },
  privacyBody: {
    ...typography.caption,
    color: colors.inkMuted,
  },
  success: {
    gap: spacing.s1,
    padding: spacing.s3,
    borderRadius: radii.r12,
    backgroundColor: "#E4F0E8",
  },
  successTitle: {
    ...typography.label,
    color: colors.success,
  },
  successDetail: {
    ...typography.caption,
    color: colors.ink,
    fontVariant: ["tabular-nums"],
  },
  error: {
    ...typography.caption,
    color: colors.danger,
  },
});
