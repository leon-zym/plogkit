import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  addTextElement,
  removeTextElement,
  reorderImages,
  setBackgroundColor,
  setCanvasRatio,
  setExportSettings,
  setStitchMode,
  setStitchSpacing,
  updateTextElement,
} from "@/core/operations";
import type { ExportSettings, Point, TextElement } from "@/core/document";
import { BackgroundPanel } from "@/features/editor/components/BackgroundPanel";
import { EditorHeader } from "@/features/editor/components/EditorHeader";
import { EditorToolbar, type EditorTool } from "@/features/editor/components/EditorToolbar";
import { ExportPanel, type ExportStatus } from "@/features/editor/components/ExportPanel";
import { StitchPanel } from "@/features/editor/components/StitchPanel";
import { TextGestureOverlay } from "@/features/editor/components/TextGestureOverlay";
import { TextPanel, type TextDraft } from "@/features/editor/components/TextPanel";
import { editorRuntime } from "@/features/editor/runtime";
import {
  useEditorDocumentStore,
  type EditorDocumentStore,
} from "@/features/editor/state/documentStore";
import { DocumentCanvas } from "@/render/DocumentCanvas";
import { exportDocument } from "@/services/export";
import { colors, spacing, typography } from "@/ui/theme";

function LoadingEditor() {
  const { t } = useTranslation();
  return (
    <SafeAreaView style={styles.loading} testID="editor-loading">
      <ActivityIndicator color={colors.accent} />
      <Text style={styles.loadingText}>{t("editor.saving")}</Text>
    </SafeAreaView>
  );
}

export default function EditorScreen() {
  const router = useRouter();
  const [store, setStore] = useState<EditorDocumentStore | null>(() => editorRuntime.getStore());

  useEffect(() => {
    if (store !== null) return;
    let active = true;
    void editorRuntime.restore().then((result) => {
      if (!active) return;
      const restoredStore = editorRuntime.getStore();
      if (result.status === "restored" && restoredStore !== null) {
        setStore(restoredStore);
      } else {
        router.replace("/" as Href);
      }
    });
    return () => {
      active = false;
    };
  }, [router, store]);

  return store === null ? <LoadingEditor /> : <ConnectedEditor store={store} />;
}

function ConnectedEditor({ store }: { readonly store: EditorDocumentStore }) {
  const { t } = useTranslation();
  const router = useRouter();
  const document = useEditorDocumentStore(store, (state) => state.document);
  const canUndo = useEditorDocumentStore(store, (state) => state.canUndo);
  const canRedo = useEditorDocumentStore(store, (state) => state.canRedo);
  const selectedTextId = useEditorDocumentStore(store, (state) => state.selectedTextId);
  const activeStoreTool = useEditorDocumentStore(store, (state) => state.activeTool);
  const commit = useEditorDocumentStore(store, (state) => state.commit);
  const undo = useEditorDocumentStore(store, (state) => state.undo);
  const redo = useEditorDocumentStore(store, (state) => state.redo);
  const setSelectedTextId = useEditorDocumentStore(store, (state) => state.setSelectedTextId);
  const setActiveTool = useEditorDocumentStore(store, (state) => state.setActiveTool);

  const [stageWidth, setStageWidth] = useState(0);
  const [spacingPreview, setSpacingPreview] = useState<number | null>(null);
  const [exportStatus, setExportStatus] = useState<ExportStatus>({ kind: "idle" });
  const [importErrorCount] = useState(() => editorRuntime.takeImportErrorCount());
  const [textIdPrefix] = useState(() => Date.now().toString(36));
  const canvasScrollRef = useRef<ScrollView>(null);
  const canvasScrollY = useRef(0);
  const canvasScrollYBeforeKeyboard = useRef<number | null>(null);
  const panelScrollRef = useRef<ScrollView>(null);
  const nextTextSequence = useRef(0);

  const canvasWidth = Math.max(0, stageWidth - spacing.s8);
  const previewDocument = useMemo(
    () => (spacingPreview === null ? document : setStitchSpacing(document, spacingPreview)),
    [document, spacingPreview],
  );
  const selectedText =
    document.textElements.find((element) => element.id === selectedTextId) ?? null;
  const activeTool: EditorTool =
    activeStoreTool === "stitch" || activeStoreTool === "text" ? activeStoreTool : "background";

  useEffect(() => {
    panelScrollRef.current?.scrollTo({ animated: false, y: 0 });
  }, [activeStoreTool, selectedTextId]);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const showSubscription = Keyboard.addListener(showEvent, () => {
      canvasScrollYBeforeKeyboard.current ??= canvasScrollY.current;
    });
    const hideSubscription = Keyboard.addListener("keyboardDidHide", () => {
      const previousOffset = canvasScrollYBeforeKeyboard.current;
      canvasScrollYBeforeKeyboard.current = null;
      if (previousOffset !== null) {
        requestAnimationFrame(() => {
          canvasScrollRef.current?.scrollTo({ animated: false, y: previousOffset });
        });
      }
    });
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  const onStageLayout = (event: LayoutChangeEvent) => {
    setStageWidth(event.nativeEvent.layout.width);
  };

  const selectText = (id: string | null) => {
    setSelectedTextId(id);
    setActiveTool("text");
  };

  const submitText = (draft: TextDraft) => {
    if (selectedText !== null) {
      const next = updateTextElement(document, selectedText.id, draft);
      commit(next);
      if (draft.content.length === 0) setSelectedTextId(null);
      return;
    }
    nextTextSequence.current += 1;
    const id = `text-${textIdPrefix}-${nextTextSequence.current}`;
    const text: TextElement = {
      id,
      ...draft,
      position: { x: 80, y: 80 },
      width: 840,
      fontId: "system-sans",
    };
    commit(addTextElement(document, text));
    setSelectedTextId(id);
    canvasScrollRef.current?.scrollTo({ animated: true, y: 0 });
  };

  const deleteSelectedText = () => {
    if (selectedText === null) return;
    commit(removeTextElement(document, selectedText.id));
    setSelectedTextId(null);
  };

  const moveText = (id: string, position: Point) => {
    commit(updateTextElement(document, id, { position }));
    selectText(id);
  };

  const updateExportSettings = (settings: ExportSettings) => {
    commit(setExportSettings(document, settings));
    setExportStatus({ kind: "idle" });
  };

  const runExport = async () => {
    setExportStatus({ kind: "exporting" });
    try {
      const firstImage = document.sourceImages[0];
      const basicMetadata =
        document.exportSettings.metadataPolicy === "retain-basic" && firstImage !== undefined
          ? await editorRuntime.readBasicMetadata(firstImage.id)
          : undefined;
      const result = await exportDocument(document, { basicMetadata });
      setExportStatus({
        kind: "success",
        width: result.plan.width,
        height: result.plan.height,
        wasReduced: result.plan.wasReduced,
      });
    } catch {
      setExportStatus({ kind: "error" });
    }
  };

  const goBack = async () => {
    try {
      await editorRuntime.flush();
    } finally {
      router.replace("/" as Href);
    }
  };

  const renderPanel = () => {
    if (activeStoreTool === "export") {
      return (
        <ExportPanel
          onExport={() => void runExport()}
          onSettingsChange={updateExportSettings}
          settings={document.exportSettings}
          status={exportStatus}
        />
      );
    }
    if (activeTool === "stitch") {
      return (
        <StitchPanel
          images={document.sourceImages}
          mode={document.stitch.mode}
          onModeChange={(mode) => commit(setStitchMode(document, mode))}
          onOrderChange={(order) => commit(reorderImages(document, order))}
          onSpacingCommit={(value) => {
            commit(setStitchSpacing(document, value));
            setSpacingPreview(null);
          }}
          onSpacingPreview={setSpacingPreview}
          order={document.stitch.order}
          spacingValue={spacingPreview ?? document.stitch.spacing}
        />
      );
    }
    if (activeTool === "text") {
      return (
        <TextPanel
          elements={document.textElements}
          onDelete={selectedText === null ? null : deleteSelectedText}
          onSelect={selectText}
          onSubmit={(draft) => {
            submitText(draft);
            panelScrollRef.current?.scrollTo({ animated: true, y: 0 });
          }}
          selected={selectedText}
        />
      );
    }
    return (
      <BackgroundPanel
        backgroundColor={document.canvas.backgroundColor}
        onBackgroundColorChange={(backgroundColor) =>
          commit(setBackgroundColor(document, backgroundColor))
        }
        onRatioChange={(ratio) => commit(setCanvasRatio(document, ratio))}
        ratio={document.canvas.ratio}
      />
    );
  };

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.root} testID="editor-screen">
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
        style={styles.keyboardLayout}
      >
        <EditorHeader
          canRedo={canRedo}
          canUndo={canUndo}
          imageCount={document.sourceImages.length}
          onBack={() => void goBack()}
          onExport={() => setActiveTool("export")}
          onRedo={redo}
          onUndo={undo}
        />
        {importErrorCount > 0 ? (
          <Text
            accessibilityLiveRegion="polite"
            style={styles.importWarning}
            testID="import-warning"
          >
            {t("home.importPartial")}
          </Text>
        ) : null}
        <View onLayout={onStageLayout} style={styles.stage}>
          <ScrollView
            contentContainerStyle={styles.canvasScrollContent}
            maximumZoomScale={3}
            minimumZoomScale={1}
            onScroll={(event) => {
              canvasScrollY.current = event.nativeEvent.contentOffset.y;
            }}
            ref={canvasScrollRef}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
          >
            {canvasWidth > 0 ? (
              <View style={styles.canvasWrapper}>
                <DocumentCanvas
                  accessibilityLabel={t("editor.photoCount", {
                    count: document.sourceImages.length,
                  })}
                  document={previewDocument}
                  width={canvasWidth}
                />
                <TextGestureOverlay
                  accessibilityLabel={(index) => `${t("text.edit")} ${index + 1}`}
                  canvasWidth={canvasWidth}
                  onCommitPosition={moveText}
                  onSelect={selectText}
                  selectedTextId={selectedTextId}
                  texts={document.textElements}
                />
              </View>
            ) : null}
          </ScrollView>
        </View>
        <EditorToolbar
          activeTool={activeTool}
          onToolChange={(tool) => {
            setActiveTool(tool);
            if (tool === "text" && selectedTextId === null) {
              canvasScrollRef.current?.scrollTo({ animated: true, y: 0 });
            }
          }}
        />
        <ScrollView
          contentContainerStyle={styles.panelScrollContent}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="always"
          ref={panelScrollRef}
          style={styles.panelScroll}
        >
          {renderPanel()}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  keyboardLayout: {
    flex: 1,
  },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.s2,
    backgroundColor: colors.stage,
  },
  loadingText: {
    ...typography.label,
    color: colors.stageMuted,
  },
  importWarning: {
    ...typography.caption,
    color: colors.ink,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.s4,
    paddingVertical: spacing.s2,
  },
  stage: {
    flex: 1,
    minHeight: 180,
    backgroundColor: colors.stage,
  },
  canvasScrollContent: {
    alignItems: "center",
    paddingVertical: spacing.s4,
  },
  canvasWrapper: {
    position: "relative",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.22)",
  },
  panelScroll: {
    flexShrink: 1,
    maxHeight: 344,
    backgroundColor: colors.surface,
  },
  panelScrollContent: {
    flexGrow: 1,
  },
});
