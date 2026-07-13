const { withAndroidManifest, withInfoPlist } = require("expo/config-plugins");

const preferences = {
  EXDevMenuIsOnboardingFinished: true,
  EXDevMenuShowFloatingActionButton: false,
  EXDevMenuShowsAtLaunch: false,
};

const withIosPreferences = (config) =>
  withInfoPlist(config, (iosConfig) => {
    Object.assign(iosConfig.modResults, preferences);
    return iosConfig;
  });

const withAndroidPreferences = (config) =>
  withAndroidManifest(config, (androidConfig) => {
    const application = androidConfig.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error("Android application manifest node is missing");
    }

    application["meta-data"] ??= [];
    for (const [name, value] of Object.entries(preferences)) {
      const existing = application["meta-data"].find((item) => item.$?.["android:name"] === name);
      const attributes = {
        "android:name": name,
        "android:value": String(value),
      };

      if (existing) {
        existing.$ = attributes;
      } else {
        application["meta-data"].push({ $: attributes });
      }
    }

    return androidConfig;
  });

module.exports = (config) => withAndroidPreferences(withIosPreferences(config));
