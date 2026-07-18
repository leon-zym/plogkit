import "@/i18n";

import { fireEvent, render } from "@testing-library/react-native";

import { parseExportSettings, type ExportPolicyError } from "@/core/exportPolicy";

import { ExportPanel } from "../ExportPanel";

const callbacks = {
  onPresetChange: jest.fn(),
  onFormatChange: jest.fn(),
  onMetadataPolicyChange: jest.fn(),
  onExport: jest.fn(),
};

describe("ExportPanel", () => {
  it("shows only the formats projected for a multi-format preset", async () => {
    const original = parseExportSettings({ presetId: "original", metadataPolicy: "strip" });
    const social = parseExportSettings({ presetId: "social", metadataPolicy: "strip" });
    const view = await render(
      <ExportPanel
        {...callbacks}
        canRetainBasic
        policyError={null}
        settings={original}
        status={{ kind: "idle" }}
      />,
    );

    expect(view.getByTestId("export-format-jpeg")).toBeTruthy();
    expect(view.getByTestId("export-format-png")).toBeTruthy();

    await view.rerender(
      <ExportPanel
        {...callbacks}
        canRetainBasic
        policyError={null}
        settings={social}
        status={{ kind: "idle" }}
      />,
    );

    expect(view.queryByTestId("export-format-jpeg")).toBeNull();
    expect(view.queryByTestId("export-format-png")).toBeNull();
  });

  it("explains an unsupported policy and prevents export", async () => {
    const settings = parseExportSettings({ presetId: "original", metadataPolicy: "strip" });
    const policyError: ExportPolicyError = {
      code: "unsupported-policy",
      reason: "format-unsupported",
      presetId: settings.presetId,
      presetRevision: 1,
      catalogSchemaVersion: 1,
    };
    const onExport = jest.fn();
    const view = await render(
      <ExportPanel
        {...callbacks}
        canRetainBasic
        onExport={onExport}
        policyError={policyError}
        settings={settings}
        status={{ kind: "idle" }}
      />,
    );

    expect(
      view.getByText(
        "This device cannot create the selected format. Choose another format or preset.",
      ),
    ).toBeTruthy();
    const exportButton = view.getByTestId("export-document");
    expect(exportButton).toHaveProp("accessibilityState", { disabled: true });

    fireEvent.press(exportButton);
    expect(onExport).not.toHaveBeenCalled();
  });

  it("maps a pipeline failure code to localized guidance", async () => {
    const settings = parseExportSettings({ presetId: "original", metadataPolicy: "strip" });
    const view = await render(
      <ExportPanel
        {...callbacks}
        canRetainBasic
        policyError={null}
        settings={settings}
        status={{ kind: "error", code: "permission-denied" }}
      />,
    );

    expect(view.getByTestId("export-error")).toHaveTextContent(
      "Allow PlogKit to add photos, then try again.",
    );
  });
});
