import { Asset, requestPermissionsAsync } from "expo-media-library";

import { ExpoPhotosDestination } from "../expoDestination";
import type { PreparedExport } from "../types";

jest.mock("expo-media-library", () => ({
  Asset: { create: jest.fn() },
  requestPermissionsAsync: jest.fn(),
}));

const createAsset = Asset.create as jest.MockedFunction<typeof Asset.create>;
const requestPermission = requestPermissionsAsync as jest.MockedFunction<
  typeof requestPermissionsAsync
>;

const prepared: PreparedExport = Object.freeze({
  kind: "static-image",
  operationId: "operation-1",
  uri: "cache:///exports/operation-1/output.jpg",
  mimeType: "image/jpeg",
  extension: "jpg",
});

describe("Expo Photos destination", () => {
  it("publishes only the PreparedExport and returns its system asset identity", async () => {
    requestPermission.mockResolvedValue({ granted: true } as never);
    createAsset.mockResolvedValue({ id: "photos-1" } as never);

    await expect(new ExpoPhotosDestination().publish(prepared)).resolves.toEqual({
      status: "published",
      assetId: "photos-1",
    });
    expect(createAsset).toHaveBeenCalledWith(prepared.uri);
  });

  it("returns permission-denied without attempting publication", async () => {
    requestPermission.mockResolvedValue({ granted: false } as never);

    await expect(new ExpoPhotosDestination().publish(prepared)).resolves.toEqual({
      status: "failure",
      code: "permission-denied",
      phase: "permission",
    });
    expect(createAsset).not.toHaveBeenCalled();
  });

  it("returns destination-failed when Photos rejects publication", async () => {
    requestPermission.mockResolvedValue({ granted: true } as never);
    createAsset.mockRejectedValue(new Error("MediaStore unavailable"));

    await expect(new ExpoPhotosDestination().publish(prepared)).resolves.toEqual({
      status: "failure",
      code: "destination-failed",
      phase: "destination",
    });
  });

  it("throws when Photos violates the non-empty identity contract", async () => {
    requestPermission.mockResolvedValue({ granted: true } as never);
    createAsset.mockResolvedValue({ id: "" } as never);

    await expect(new ExpoPhotosDestination().publish(prepared)).rejects.toThrow(
      "empty system asset identity",
    );
  });

  it("cancels before requesting permission when the caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      new ExpoPhotosDestination().publish(prepared, controller.signal),
    ).resolves.toEqual({ status: "cancelled", phase: "permission" });
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
