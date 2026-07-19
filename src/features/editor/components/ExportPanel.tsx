import { useTranslation } from "react-i18next";
import { StyleSheet, Switch, Text, View } from "react-native";

import {
  listPresetOptions,
  type ExportFormat,
  type ExportPolicyError,
  type ExportPresetId,
  type ExportSettings,
  type MetadataPolicy,
} from "@/core/exportPolicy";
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
      readonly format: ExportFormat;
    }
  | { readonly kind: "error" };

interface ExportPanelProps {
  readonly settings: ExportSettings;
  readonly status: ExportStatus;
  readonly policyError: ExportPolicyError | null;
  readonly canRetainBasic: boolean;
  readonly onPresetChange: (presetId: ExportPresetId) => void;
  readonly onFormatChange: (format: ExportFormat) => void;
  readonly onMetadataPolicyChange: (policy: MetadataPolicy) => void;
  readonly onExport: () => void;
}

function policyErrorMessageKey(error: ExportPolicyError): string {
  if (error.code === "preset-unavailable") return "export.policyErrors.presetUnavailable";
  switch (error.reason) {
    case "format-not-allowed":
      return "export.policyErrors.formatNotAllowed";
    case "metadata-not-allowed":
      return "export.policyErrors.metadataNotAllowed";
    case "format-unsupported":
      return "export.policyErrors.formatUnsupported";
    case "metadata-unsupported":
      return "export.policyErrors.metadataUnsupported";
    case "dynamic-range-unsupported":
      return "export.policyErrors.dynamicRangeUnsupported";
    case "dynamic-photo-unsupported":
      return "export.policyErrors.dynamicPhotoUnsupported";
    case "precompression-unsupported":
      return "export.policyErrors.precompressionUnsupported";
    case "post-process-unsupported":
      return "export.policyErrors.postProcessUnsupported";
  }
}

export function ExportPanel({
  settings,
  status,
  policyError,
  canRetainBasic,
  onPresetChange,
  onFormatChange,
  onMetadataPolicyChange,
  onExport,
}: ExportPanelProps) {
  const { t } = useTranslation();
  const options = listPresetOptions();
  const selectedPreset = options.find(({ id }) => id === settings.presetId);
  const selectedFormat = settings.formatOverride ?? selectedPreset?.defaultFormat;
  const presetOptions = options.map(({ id, labelKey }) => ({
    value: id,
    label: t(labelKey),
    accessibilityLabel: t(labelKey),
  }));
  const formatOptions =
    selectedPreset?.allowedFormats.map((format) => ({
      value: format,
      label: format.toUpperCase(),
      accessibilityLabel: format.toUpperCase(),
    })) ?? [];
  const retainBasic = canRetainBasic && settings.metadataPolicy === "retain-basic";

  return (
    <PanelShell title={t("export.title")}>
      <View style={panelStyles.section}>
        <Text style={panelStyles.sectionLabel}>{t("export.preset")}</Text>
        <OptionRow
          onChange={onPresetChange}
          options={presetOptions}
          testIDPrefix="export-preset"
          value={settings.presetId}
        />
      </View>
      {selectedPreset !== undefined && selectedFormat !== undefined && formatOptions.length > 1 ? (
        <View style={panelStyles.section}>
          <Text style={panelStyles.sectionLabel}>{t("export.format")}</Text>
          <OptionRow
            onChange={onFormatChange}
            options={formatOptions}
            testIDPrefix="export-format"
            value={selectedFormat}
          />
        </View>
      ) : null}
      <View style={styles.privacyRow}>
        <View style={styles.privacyCopy}>
          <Text style={styles.privacyTitle}>{t("export.retainBasic")}</Text>
          <Text style={styles.privacyBody}>
            {canRetainBasic ? t("export.sRGBNotice") : t("export.retainUnavailable")}
          </Text>
        </View>
        <Switch
          accessibilityLabel={t("export.retainBasic")}
          disabled={!canRetainBasic}
          onValueChange={(enabled) => onMetadataPolicyChange(enabled ? "retain-basic" : "strip")}
          testID="export-retain-basic"
          thumbColor={colors.surface}
          trackColor={{ false: colors.line, true: colors.accent }}
          value={retainBasic}
        />
      </View>
      {policyError !== null ? (
        <Text accessibilityLiveRegion="assertive" style={styles.error} testID="export-policy-error">
          {t(policyErrorMessageKey(policyError))}
        </Text>
      ) : null}
      {status.kind === "success" ? (
        <View accessibilityLiveRegion="polite" style={styles.success} testID="export-success">
          <Text style={styles.successTitle}>{t("export.success")}</Text>
          {status.wasReduced ? (
            <Text style={styles.successDetail}>
              {t("export.reduced", { width: status.width, height: status.height })}
            </Text>
          ) : (
            <Text style={styles.successDetail}>
              {status.format.toUpperCase()} · {status.width} × {status.height}
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
        disabled={status.kind === "exporting" || policyError !== null}
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
