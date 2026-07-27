import type { SkCanvas, SkImage, SkParagraph, SkSurface } from "@shopify/react-native-skia";

import { importedAssetId } from "../../core/document";
import type { RenderScene } from "../scene";
import {
  createSkiaOffscreenSceneRenderer,
  type SkiaOffscreenEncoding,
  type SkiaOffscreenRenderAdapter,
  type SkiaOffscreenTarget,
  type SkiaOriginalAssetLoadResult,
} from "../skiaOffscreenRenderer";
import { createTextLayoutEnvironment, createUnavailableTextLayoutEnvironment } from "../textLayout";

const firstImageId = importedAssetId("first");
const secondImageId = importedAssetId("second");

const scene: RenderScene = {
  width: 100,
  height: 200,
  backgroundColor: "#112233",
  images: [
    {
      imageId: firstImageId,
      sourceSize: { width: 10, height: 20 },
      destination: { x: 0, y: 0, width: 100, height: 100 },
    },
    {
      imageId: secondImageId,
      sourceSize: { width: 10, height: 20 },
      destination: { x: 0, y: 100, width: 100, height: 100 },
    },
  ],
  texts: [],
};

const singleTarget: SkiaOffscreenTarget = {
  id: "single",
  width: 100,
  height: 200,
  transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 },
  encoding: { format: "png" },
};

const batchTargets = [
  {
    id: "square",
    width: 100,
    height: 100,
    transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: -50 },
    encoding: { format: "jpeg", quality: 0.82 },
  },
  {
    id: "original",
    width: 50,
    height: 100,
    transform: { scaleX: 0.5, scaleY: 0.5, translateX: 0, translateY: 0 },
    encoding: { format: "jpeg", quality: 0.82 },
  },
] as const;

interface FakeRuntimeOptions {
  readonly getTextLayoutEnvironment?: SkiaOffscreenRenderAdapter["getTextLayoutEnvironment"];
  readonly loadOriginalAsset?: (uri: string) => Promise<SkiaOriginalAssetLoadResult>;
  readonly makeSurface?: (width: number, height: number, index: number) => SkSurface | null;
  readonly onDrawImage?: () => void;
  readonly encodeSnapshot?: (
    snapshot: SkImage,
    encoding: SkiaOffscreenEncoding,
    index: number,
  ) => Uint8Array;
}

function createFakeRuntime(options: FakeRuntimeOptions = {}) {
  const events: string[] = [];
  const surfaceDisposals: jest.Mock[] = [];
  const snapshotDisposals: jest.Mock[] = [];
  const imageDisposals: jest.Mock[] = [];
  const paintDisposals: jest.Mock[] = [];
  let surfaceIndex = 0;
  let encodeIndex = 0;

  const defaultMakeSurface = (_width: number, _height: number): SkSurface => {
    const targetId = batchTargets[surfaceIndex]?.id ?? singleTarget.id;
    surfaceIndex += 1;
    const surfaceDispose = jest.fn();
    const snapshotDispose = jest.fn();
    surfaceDisposals.push(surfaceDispose);
    snapshotDisposals.push(snapshotDispose);
    const canvas = {
      translate: jest.fn(),
      scale: jest.fn(),
      drawRect: jest.fn(() => events.push(`${targetId}:background`)),
      drawImageRectOptions: jest.fn(() => {
        events.push(`${targetId}:image`);
        options.onDrawImage?.();
      }),
    } as unknown as SkCanvas;
    return {
      getCanvas: () => canvas,
      flush: jest.fn(),
      makeImageSnapshot: () =>
        ({
          testTargetId: targetId,
          dispose: snapshotDispose,
        }) as unknown as SkImage,
      dispose: surfaceDispose,
    } as unknown as SkSurface;
  };

  const adapter: SkiaOffscreenRenderAdapter = {
    api: {
      Color: (color: string) => color as never,
      Paint: () => {
        const dispose = jest.fn();
        paintDisposals.push(dispose);
        return {
          setColor: jest.fn(),
          setAntiAlias: jest.fn(),
          dispose,
        } as never;
      },
      XYWHRect: (x: number, y: number, width: number, height: number) => ({
        x,
        y,
        width,
        height,
      }),
    } as unknown as SkiaOffscreenRenderAdapter["api"],
    makeSurface: (width, height) =>
      options.makeSurface === undefined
        ? defaultMakeSurface(width, height)
        : options.makeSurface(width, height, surfaceIndex),
    loadOriginalAsset:
      options.loadOriginalAsset ??
      (async () => {
        const dispose = jest.fn();
        imageDisposals.push(dispose);
        return {
          status: "ready",
          image: {
            width: () => 10,
            height: () => 20,
            dispose,
          } as unknown as SkImage,
        };
      }),
    getTextLayoutEnvironment:
      options.getTextLayoutEnvironment ??
      (() => createUnavailableTextLayoutEnvironment("text is unavailable in this fake")),
    encodeSnapshot: (snapshot, encoding) => {
      const index = encodeIndex;
      encodeIndex += 1;
      return options.encodeSnapshot?.(snapshot, encoding, index) ?? Uint8Array.from([index + 1]);
    },
  };

  return {
    renderer: createSkiaOffscreenSceneRenderer(adapter),
    events,
    surfaceDisposals,
    snapshotDisposals,
    imageDisposals,
    paintDisposals,
  };
}

const assets = {
  resolve: (assetId: typeof firstImageId | typeof secondImageId) => ({
    uri: `fixture://${assetId}`,
  }),
};

describe("shared Skia offscreen scene renderer", () => {
  it("renders a two-target full composition with one text layout and one decoded asset at a time", async () => {
    const paragraphDispose = jest.fn();
    const paragraph = {
      layout: jest.fn(),
      getLineMetrics: jest.fn(() => []),
      getHeight: jest.fn(() => 24),
      paint: jest.fn((canvas: SkCanvas) => {
        const targetId = (canvas as unknown as { targetId?: string }).targetId;
        if (targetId !== undefined) return;
      }),
      dispose: paragraphDispose,
    } as unknown as SkParagraph;
    const builderMake = jest.fn(() => ({
      pushStyle: jest.fn(),
      addText: jest.fn(),
      pop: jest.fn(),
      build: () => paragraph,
      dispose: jest.fn(),
    }));
    const textEnvironment = createTextLayoutEnvironment({
      api: {
        Color: (color: string) => color as never,
        ParagraphBuilder: { Make: builderMake },
      } as never,
      fontProvider: {} as never,
      fontFamilies: { "system-sans": ["Test Sans"] },
    });
    let activeImages = 0;
    let maximumActiveImages = 0;
    const runtime = createFakeRuntime({
      getTextLayoutEnvironment: () => textEnvironment,
      loadOriginalAsset: async () => {
        activeImages += 1;
        maximumActiveImages = Math.max(maximumActiveImages, activeImages);
        const dispose = jest.fn(() => {
          activeImages -= 1;
        });
        runtime.imageDisposals.push(dispose);
        return {
          status: "ready",
          image: {
            width: () => 10,
            height: () => 20,
            dispose,
          } as unknown as SkImage,
        };
      },
    });
    const sceneWithText: RenderScene = {
      ...scene,
      texts: [
        {
          id: "caption",
          content: "周末",
          x: 10,
          y: 20,
          width: 80,
          fontId: "system-sans",
          fontSize: 20,
          color: "#ffffff",
          alignment: "left",
          lineHeight: 1.2,
          backgroundColor: null,
        },
      ],
    };

    const result = await runtime.renderer.render({
      scene: sceneWithText,
      assets,
      targets: batchTargets,
    });

    expect(result).toEqual({
      status: "rendered",
      outputs: {
        square: {
          targetId: "square",
          width: 100,
          height: 100,
          bytes: Uint8Array.from([1]),
        },
        original: {
          targetId: "original",
          width: 50,
          height: 100,
          bytes: Uint8Array.from([2]),
        },
      },
    });
    expect(builderMake).toHaveBeenCalledTimes(1);
    expect(paragraph.paint).toHaveBeenCalledTimes(2);
    expect(paragraphDispose).toHaveBeenCalledTimes(1);
    expect(maximumActiveImages).toBe(1);
    expect(runtime.imageDisposals).toHaveLength(2);
    expect(runtime.imageDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(runtime.events.filter((event) => event.startsWith("square"))).toEqual([
      "square:background",
      "square:image",
      "square:image",
    ]);
    expect(runtime.events.filter((event) => event.startsWith("original"))).toEqual([
      "original:background",
      "original:image",
      "original:image",
    ]);
    expect(runtime.surfaceDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(runtime.snapshotDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(
      true,
    );
    expect(runtime.paintDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it.each([
    [
      "missing descriptor",
      {
        assets: { resolve: () => null },
        loadOriginalAsset: undefined,
        code: "original-asset-unavailable",
      },
    ],
    [
      "read failure",
      {
        assets,
        loadOriginalAsset: async () => ({
          status: "failure" as const,
          code: "load-failed" as const,
          message: "read failed",
        }),
        code: "original-asset-load-failed",
      },
    ],
    [
      "decode failure",
      {
        assets,
        loadOriginalAsset: async () => ({
          status: "failure" as const,
          code: "decode-failed" as const,
          message: "decode failed",
        }),
        code: "original-asset-decode-failed",
      },
    ],
  ])("returns a typed asset failure for %s", async (_label, testCase) => {
    const runtime = createFakeRuntime({
      ...(testCase.loadOriginalAsset === undefined
        ? {}
        : { loadOriginalAsset: testCase.loadOriginalAsset }),
    });

    const result = await runtime.renderer.render({
      scene,
      assets: testCase.assets,
      targets: [singleTarget],
    });

    expect(result).toMatchObject({
      status: "failure",
      code: testCase.code,
      phase: "assets",
      assetId: firstImageId,
    });
    expect(runtime.surfaceDisposals[0]).toHaveBeenCalledTimes(1);
  });

  it("returns no partial batch when the second encode fails and releases every resource", async () => {
    const runtime = createFakeRuntime({
      encodeSnapshot: (_snapshot, _encoding, index) => {
        if (index === 1) throw new Error("encoder unavailable");
        return Uint8Array.from([1]);
      },
    });

    const result = await runtime.renderer.render({
      scene,
      assets,
      targets: batchTargets,
    });

    expect(result).toEqual({
      status: "failure",
      code: "encode-failed",
      phase: "encode",
      targetId: "original",
      message: "encoder unavailable",
    });
    expect(result).not.toHaveProperty("outputs");
    expect(runtime.surfaceDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(runtime.snapshotDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(
      true,
    );
    expect(runtime.imageDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it("returns typed text-layout, surface, and draw failures at the renderer interface", async () => {
    const textRuntime = createFakeRuntime();
    const sceneWithText: RenderScene = {
      ...scene,
      texts: [
        {
          id: "caption",
          content: "A",
          x: 0,
          y: 0,
          width: 50,
          fontId: "system-sans",
          fontSize: 20,
          color: "#ffffff",
          alignment: "left",
          lineHeight: 1.2,
          backgroundColor: null,
        },
      ],
    };
    await expect(
      textRuntime.renderer.render({
        scene: sceneWithText,
        assets,
        targets: [singleTarget],
      }),
    ).resolves.toEqual({
      status: "failure",
      code: "text-layout-failed",
      phase: "render",
      message: "text is unavailable in this fake",
    });
    expect(textRuntime.surfaceDisposals).toHaveLength(0);

    const surfaceRuntime = createFakeRuntime({
      makeSurface: () => null,
    });
    await expect(
      surfaceRuntime.renderer.render({
        scene,
        assets,
        targets: [singleTarget],
      }),
    ).resolves.toMatchObject({
      status: "failure",
      code: "surface-failed",
      phase: "render",
      targetId: "single",
    });

    const drawRuntime = createFakeRuntime({
      onDrawImage: () => {
        throw new Error("draw failed");
      },
    });
    await expect(
      drawRuntime.renderer.render({
        scene,
        assets,
        targets: [singleTarget],
      }),
    ).resolves.toEqual({
      status: "failure",
      code: "draw-failed",
      phase: "render",
      targetId: "single",
      message: "draw failed",
    });
    expect(drawRuntime.imageDisposals[0]).toHaveBeenCalledTimes(1);
    expect(drawRuntime.surfaceDisposals[0]).toHaveBeenCalledTimes(1);
  });

  it("observes cancellation before work and during assets, render, and encode", async () => {
    const before = new AbortController();
    before.abort();
    const beforeRuntime = createFakeRuntime();
    await expect(
      beforeRuntime.renderer.render({
        scene,
        assets,
        targets: [singleTarget],
        signal: before.signal,
      }),
    ).resolves.toEqual({ status: "cancelled", phase: "assets" });
    expect(beforeRuntime.surfaceDisposals).toHaveLength(0);

    const duringAssets = new AbortController();
    const assetRuntime = createFakeRuntime({
      loadOriginalAsset: async () => {
        duringAssets.abort();
        const dispose = jest.fn();
        assetRuntime.imageDisposals.push(dispose);
        return {
          status: "ready",
          image: {
            width: () => 10,
            height: () => 20,
            dispose,
          } as unknown as SkImage,
        };
      },
    });
    await expect(
      assetRuntime.renderer.render({
        scene,
        assets,
        targets: [singleTarget],
        signal: duringAssets.signal,
      }),
    ).resolves.toEqual({ status: "cancelled", phase: "assets" });
    expect(assetRuntime.imageDisposals[0]).toHaveBeenCalledTimes(1);

    const duringRender = new AbortController();
    const renderRuntime = createFakeRuntime({
      onDrawImage: () => duringRender.abort(),
    });
    await expect(
      renderRuntime.renderer.render({
        scene,
        assets,
        targets: [singleTarget],
        signal: duringRender.signal,
      }),
    ).resolves.toEqual({ status: "cancelled", phase: "render" });

    const duringEncode = new AbortController();
    const encodeRuntime = createFakeRuntime({
      encodeSnapshot: () => {
        duringEncode.abort();
        return Uint8Array.from([1]);
      },
    });
    await expect(
      encodeRuntime.renderer.render({
        scene,
        assets,
        targets: [singleTarget],
        signal: duringEncode.signal,
      }),
    ).resolves.toEqual({ status: "cancelled", phase: "encode" });
    expect(encodeRuntime.snapshotDisposals[0]).toHaveBeenCalledTimes(1);
  });

  it("releases owned resources before propagating caller or adapter programming errors", async () => {
    const callerRuntime = createFakeRuntime();

    await expect(
      callerRuntime.renderer.render({
        scene,
        assets: {
          resolve: () => {
            throw new Error("catalog snapshot contract violated");
          },
        },
        targets: [singleTarget],
      }),
    ).rejects.toThrow("catalog snapshot contract violated");
    expect(callerRuntime.surfaceDisposals[0]).toHaveBeenCalledTimes(1);

    const adapterRuntime = createFakeRuntime({
      loadOriginalAsset: async () => {
        throw new Error("adapter contract violated");
      },
    });
    await expect(
      adapterRuntime.renderer.render({
        scene,
        assets,
        targets: [singleTarget],
      }),
    ).rejects.toThrow("adapter contract violated");
    expect(adapterRuntime.surfaceDisposals[0]).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "non-positive dimensions",
      [{ ...singleTarget, width: 0 }],
      "width must be a positive integer",
    ],
    [
      "non-positive scale",
      [{ ...singleTarget, transform: { ...singleTarget.transform, scaleX: 0 } }],
      "scale must be positive and finite",
    ],
    [
      "non-finite translation",
      [{ ...singleTarget, transform: { ...singleTarget.transform, translateY: Infinity } }],
      "translation must be finite",
    ],
    [
      "invalid JPEG quality",
      [{ ...singleTarget, encoding: { format: "jpeg" as const, quality: 1.1 } }],
      "JPEG quality must be between 0 and 1",
    ],
    [
      "duplicate target ids",
      [singleTarget, { ...singleTarget, width: 50, height: 100 }],
      "must be unique",
    ],
  ] as const)(
    "rejects %s before creating owned resources",
    async (_label, targets, expectedMessage) => {
      const runtime = createFakeRuntime();

      await expect(
        runtime.renderer.render({
          scene,
          assets,
          targets,
        }),
      ).resolves.toEqual({
        status: "failure",
        code: "target-invalid",
        phase: "render",
        message: expect.stringContaining(expectedMessage),
      });
      expect(runtime.surfaceDisposals).toHaveLength(0);
    },
  );

  it.each([
    [
      "a target long edge above the Thumbnail limit",
      [
        { ...batchTargets[0], width: 721 },
        batchTargets[1],
      ],
      "long edges must not exceed 720px",
    ],
    [
      "aggregate output pixels above the Thumbnail limit",
      [
        { ...batchTargets[0], width: 720, height: 450 },
        { ...batchTargets[1], width: 720, height: 451 },
      ],
      "must not exceed 648000 total output pixels",
    ],
  ] as const)("rejects two-target batch %s before creating a surface", async (
    _label,
    targets,
    expectedMessage,
  ) => {
    const makeSurface = jest.fn(() => null);
    const runtime = createFakeRuntime({ makeSurface });

    await expect(
      runtime.renderer.render({
        scene,
        assets,
        targets,
      }),
    ).resolves.toEqual({
      status: "failure",
      code: "target-invalid",
      phase: "render",
      message: expect.stringContaining(expectedMessage),
    });
    expect(makeSurface).not.toHaveBeenCalled();
  });

  it("accepts the exact Thumbnail batch limits without restricting a single export target", async () => {
    const batchRuntime = createFakeRuntime();
    await expect(
      batchRuntime.renderer.render({
        scene,
        assets,
        targets: [
          { ...batchTargets[0], width: 720, height: 450 },
          { ...batchTargets[1], width: 720, height: 450 },
        ],
      }),
    ).resolves.toMatchObject({ status: "rendered" });

    const exportRuntime = createFakeRuntime();
    await expect(
      exportRuntime.renderer.render({
        scene,
        assets,
        targets: [{ ...singleTarget, width: 4096, height: 4096 }],
      }),
    ).resolves.toMatchObject({ status: "rendered" });
  });
});
