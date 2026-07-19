import {
  Canvas,
  Group,
  Image,
  Line,
  Picture,
  Rect,
  Skia,
  type SkImage,
  type SkPicture,
} from "@shopify/react-native-skia";
import React, { useEffect, useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";

import {
  resolveSceneImageUri,
  type RenderScene,
  type SceneImage,
  type SceneImageAssetResolver,
} from "@/render/scene";
import type { TextLayout, TextLayoutSnapshot } from "@/render/textLayout";

interface ImageLoadState {
  readonly uri: string;
  readonly status: "ready" | "error";
  readonly image: SkImage | null;
}

function useDisposableImage(uri: string): ImageLoadState | null {
  const [state, setState] = useState<ImageLoadState | null>(null);

  useEffect(() => {
    let cancelled = false;
    let ownedImage: SkImage | null = null;

    void Skia.Data.fromURI(uri)
      .then((data) => {
        try {
          ownedImage = Skia.Image.MakeImageFromEncoded(data);
        } finally {
          data.dispose();
        }

        if (cancelled) {
          ownedImage?.dispose();
          ownedImage = null;
          return;
        }
        setState({
          uri,
          status: ownedImage === null ? "error" : "ready",
          image: ownedImage,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ uri, status: "error", image: null });
        }
      });

    return () => {
      cancelled = true;
      ownedImage?.dispose();
      ownedImage = null;
    };
  }, [uri]);

  return state?.uri === uri ? state : null;
}

function PendingImage({ node, failed }: { readonly node: SceneImage; readonly failed: boolean }) {
  const { x, y, width, height } = node.destination;
  const color = failed ? "#A83A3A" : "#8A8A8A";
  return (
    <Group>
      <Rect x={x} y={y} width={width} height={height} color="#E3E3E3" />
      <Rect
        x={x}
        y={y}
        width={width}
        height={height}
        color={color}
        style="stroke"
        strokeWidth={Math.max(2, width / 250)}
      />
      <Line p1={{ x, y }} p2={{ x: x + width, y: y + height }} color={color} strokeWidth={3} />
      <Line p1={{ x: x + width, y }} p2={{ x, y: y + height }} color={color} strokeWidth={3} />
    </Group>
  );
}

function SceneImageNode({
  assets,
  node,
}: {
  readonly assets: SceneImageAssetResolver;
  readonly node: SceneImage;
}) {
  const uri = resolveSceneImageUri(assets, node, "preview");
  const state = useDisposableImage(uri);
  if (state?.image === null || state?.image === undefined) {
    return <PendingImage node={node} failed={state?.status === "error"} />;
  }
  return (
    <Image
      image={state.image}
      x={node.destination.x}
      y={node.destination.y}
      width={node.destination.width}
      height={node.destination.height}
      fit="fill"
    />
  );
}

interface PictureState {
  readonly layout: TextLayout;
  readonly picture: SkPicture;
}

function useDisposableTextPicture(layout: TextLayout, scene: RenderScene): SkPicture | null {
  const [state, setState] = useState<PictureState | null>(null);
  useEffect(() => {
    let cancelled = false;
    let disposed = false;
    const recorder = Skia.PictureRecorder();
    let nextPicture: SkPicture;
    try {
      const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, scene.width, scene.height));
      layout.paragraph.paint(canvas, layout.placement.x, layout.placement.y);
      nextPicture = recorder.finishRecordingAsPicture();
    } finally {
      recorder.dispose();
    }
    const dispose = () => {
      if (!disposed) {
        nextPicture.dispose();
        disposed = true;
      }
    };
    void Promise.resolve().then(() => {
      if (cancelled) {
        dispose();
      } else {
        setState({ layout, picture: nextPicture });
      }
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [layout, scene.height, scene.width]);
  return state?.layout === layout ? state.picture : null;
}

function SceneTextNode({
  layout,
  scene,
}: {
  readonly layout: TextLayout;
  readonly scene: RenderScene;
}) {
  const picture = useDisposableTextPicture(layout, scene);
  return picture === null ? null : <Picture picture={picture} />;
}

export interface DocumentCanvasProps {
  readonly assets: SceneImageAssetResolver;
  readonly scene: RenderScene;
  readonly textLayout: TextLayoutSnapshot | null;
  readonly width: number;
  readonly accessibilityLabel: string;
  readonly testID?: string;
  readonly style?: StyleProp<ViewStyle>;
}

/** Device preview resolves the Draft's preview descriptor; export resolves the original. */
export function DocumentCanvas({
  assets,
  scene,
  textLayout,
  width,
  accessibilityLabel,
  testID = "document-canvas",
  style,
}: DocumentCanvasProps) {
  const scale = width / scene.width;

  if (!Number.isFinite(width) || width <= 0) {
    throw new Error("DocumentCanvas width must be a positive finite number");
  }

  return (
    <Canvas
      accessible
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={[style, { width, height: scene.height * scale }]}
    >
      <Group transform={[{ scale }]}>
        <Rect x={0} y={0} width={scene.width} height={scene.height} color={scene.backgroundColor} />
        {scene.images.map((image) => (
          <SceneImageNode assets={assets} key={image.imageId} node={image} />
        ))}
        {textLayout?.layouts.map((layout) => (
          <SceneTextNode key={layout.id} layout={layout} scene={scene} />
        ))}
      </Group>
    </Canvas>
  );
}
