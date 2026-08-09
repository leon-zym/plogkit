export async function prepareAndWarmDevices({
  artifactRoot,
  assertAndroidDeviceReady,
  cleanup,
  deviceId,
  installAndSeed,
  platforms,
  prewarmMetroBundle,
  prepareDevice,
  root,
  startMetro,
  warmUpApp,
}) {
  const devices = [];
  let metro = null;

  for (const platform of platforms) {
    const device = await prepareDevice(platform, { artifactRoot, cleanup, deviceId });
    await installAndSeed(device, cleanup);

    if (!metro) {
      metro = (await startMetro({ artifactRoot, cleanup, root })) ?? {};
    }

    if (device.platform === "android") {
      await assertAndroidDeviceReady({ artifactRoot, device, stage: "post-install" });
    }
    if (device.platform === "ios") {
      const prewarm = prewarmMetroBundle({ artifactRoot, platform: device.platform });
      if (metro.failure) {
        await Promise.race([
          prewarm,
          metro.failure.then((error) => {
            throw error;
          }),
        ]);
      } else {
        await prewarm;
      }
    }
    const warmUp = warmUpApp({ artifactRoot, cleanup, device, root });
    if (metro.failure) {
      await Promise.race([
        warmUp,
        metro.failure.then((error) => {
          throw error;
        }),
      ]);
    } else {
      await warmUp;
    }
    devices.push(device);
  }

  return devices;
}
