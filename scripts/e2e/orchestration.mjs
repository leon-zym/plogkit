export async function prepareAndWarmDevices({
  artifactRoot,
  assertAndroidDeviceReady,
  cleanup,
  deviceId,
  installAndSeed,
  platforms,
  prepareDevice,
  root,
  startMetro,
  warmUpApp,
}) {
  const devices = [];
  let metroStarted = false;

  for (const platform of platforms) {
    const device = await prepareDevice(platform, { artifactRoot, cleanup, deviceId });
    await installAndSeed(device, cleanup);

    if (!metroStarted) {
      await startMetro({ artifactRoot, cleanup, root });
      metroStarted = true;
    }

    if (device.platform === "android") {
      await assertAndroidDeviceReady({ artifactRoot, device, stage: "post-install" });
    }
    await warmUpApp({ artifactRoot, cleanup, device, root });
    devices.push(device);
  }

  return devices;
}
