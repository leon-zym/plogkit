import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTemporaryTestDirectory } from "../test-support/temp-directory.mjs";
import { androidBuildArtifact, androidBuildSidecars, buildAndroid } from "./android.mjs";
import { buildIos, iosAcceptanceContract, iosBuildArtifact, iosBuildSidecars } from "./ios.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const compatibleExpoModulesCoreSymbol =
  "_$s15ExpoModulesCore9AnyModuleP09_decorateE06object2iny0aB3JSI16JavaScriptObjectV_AG0jK7RuntimeCtKF";

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createIosReleaseBuildFixture(
  t,
  {
    architecture = "arm64",
    coreExports = [compatibleExpoModulesCoreSymbol],
    mediaImports = [compatibleExpoModulesCoreSymbol],
  } = {},
) {
  const directory = createTemporaryTestDirectory(t, "plogkit-ios-release-build-");
  const binaries = join(directory, "bin");
  const commandLog = join(directory, "xcodebuild-args.log");
  const app = join(directory, "ios/build/Build/Products/Release-iphonesimulator/PlogKit.app");
  const appBinary = join(app, "PlogKit");
  const coreBinary = join(app, "Frameworks/ExpoModulesCore.framework/ExpoModulesCore");
  const mediaBinary = join(app, "Frameworks/ExpoMediaLibrary.framework/ExpoMediaLibrary");
  mkdirSync(binaries);
  writeExecutable(
    join(binaries, "xcodebuild"),
    `#!/bin/sh
printf '%s\n' "\${NODE_ENV:-unset}" > "${commandLog}"
printf '%s\n' "$*" >> "${commandLog}"
mkdir -p "${app}"
printf '\\306\\037\\274\\003\\301\\003\\031\\037bundle' > "${app}/main.jsbundle"
printf '%s' app > "${appBinary}"
mkdir -p "$(dirname "${coreBinary}")" "$(dirname "${mediaBinary}")"
printf '%s' core > "${coreBinary}"
printf '%s' media > "${mediaBinary}"
mkdir -p "${directory}/ios/build/Build/Products/Release-iphonesimulator/PlogKit.app.dSYM/Contents/Resources/DWARF"
printf '%s' symbols > "${directory}/ios/build/Build/Products/Release-iphonesimulator/PlogKit.app.dSYM/Contents/Resources/DWARF/PlogKit"
`,
  );
  writeExecutable(
    join(binaries, "xcrun"),
    `#!/bin/sh
case "$*" in
  "lipo -archs ${appBinary}"|"lipo -archs ${coreBinary}"|"lipo -archs ${mediaBinary}")
    printf '%s\\n' ${architecture} ;;
  "nm -arch ${architecture} -gU ${coreBinary}")
    printf '%s\\n' ${coreExports.map((symbol) => `'0000000000001000 T ${symbol}'`).join(" ")} ;;
  "nm -arch ${architecture} -u ${mediaBinary}")
    printf '%s\\n' ${mediaImports.map((symbol) => `'                 U ${symbol}'`).join(" ")} ;;
  "nm -arch ${architecture} -u ${appBinary}")
    printf '%s\\n' '                 U _$s10Foundation3URLVMa' ;;
  *) exit 65 ;;
esac
`,
  );
  return { binaries, commandLog, directory };
}

test("iOS E2E builds a standalone Release simulator app", async (t) => {
  const { binaries, commandLog, directory } = createIosReleaseBuildFixture(t);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    await buildIos({
      architecture: "arm64",
      cleanup: { add() {} },
      root: directory,
      workers: "2",
    });
  } finally {
    process.env.PATH = previousPath;
  }

  const [nodeEnvironment, argumentsLine] = readFileSync(commandLog, "utf8").trim().split("\n");
  assert.equal(nodeEnvironment, "production");
  assert.match(argumentsLine, /-configuration Release/);
  assert.match(argumentsLine, /ARCHS=arm64/);
  assert.match(argumentsLine, /ONLY_ACTIVE_ARCH=YES/);
  assert.match(argumentsLine, /CODE_SIGNING_ALLOWED=NO build/);
  assert.doesNotMatch(argumentsLine, /\bDebug\b/);
  assert.equal(
    iosBuildArtifact(directory),
    join(directory, "ios/build/Build/Products/Release-iphonesimulator/PlogKit.app"),
  );
  assert.deepEqual(iosBuildSidecars(directory), [
    join(directory, "ios/build/Build/Products/Release-iphonesimulator/PlogKit.app.dSYM"),
  ]);
});

test("iOS E2E builds the x86_64-only Release slice selected by an Intel test host", async (t) => {
  const { binaries, commandLog, directory } = createIosReleaseBuildFixture(t, {
    architecture: "x86_64",
  });

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    await buildIos({
      architecture: "x86_64",
      cleanup: { add() {} },
      root: directory,
      workers: "2",
    });
  } finally {
    process.env.PATH = previousPath;
  }

  const argumentsLine = readFileSync(commandLog, "utf8").trim().split("\n")[1];
  assert.match(argumentsLine, /ARCHS=x86_64/);
  assert.match(argumentsLine, /ONLY_ACTIVE_ARCH=YES/);
});

test("the iOS acceptance contract explicitly binds the native Release build", () => {
  assert.deepEqual(iosAcceptanceContract("x86_64"), {
    architecture: "x86_64",
    configuration: "Release",
    deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
    runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
    scheme: "PlogKit",
    sdk: "iphonesimulator",
    xcodeBuild: "17F113",
    xcodeVersion: "26.6",
  });
});

test("iOS Release build rejects an embedded ExpoModulesCore ABI mismatch", async (t) => {
  const missingSymbol = `${compatibleExpoModulesCoreSymbol}Missing`;
  const { binaries, directory } = createIosReleaseBuildFixture(t, {
    mediaImports: [missingSymbol],
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    await assert.rejects(
      buildIos({
        architecture: "arm64",
        cleanup: { add() {} },
        root: directory,
        workers: "2",
      }),
      /ExpoMediaLibrary.*symbol.*missing.*Missing/s,
    );
  } finally {
    process.env.PATH = previousPath;
  }
});

test("Android E2E builds a standalone Release APK for the device architecture", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-android-release-build-");
  const androidDirectory = join(directory, "android");
  const binaries = join(directory, "bin");
  const commandLog = join(directory, "gradle-args.log");
  mkdirSync(androidDirectory);
  mkdirSync(binaries);
  writeExecutable(
    join(androidDirectory, "gradlew"),
    `#!/bin/sh
printf '%s\n' "\${NODE_ENV:-unset}" > "${commandLog}"
printf '%s\n' "\${GRADLE_USER_HOME:-unset}" >> "${commandLog}"
printf '%s\n' "$*" >> "${commandLog}"
mkdir -p "${directory}/android/app/build/outputs/apk/release"
printf '%s' apk > "${directory}/android/app/build/outputs/apk/release/app-release.apk"
mkdir -p "${directory}/android/app/build/generated/sourcemaps/react/release"
printf '%s' source-map > "${directory}/android/app/build/generated/sourcemaps/react/release/index.android.bundle.map"
mkdir -p "${directory}/android/app/build/outputs/native-debug-symbols/release"
printf '%s' native-symbols > "${directory}/android/app/build/outputs/native-debug-symbols/release/native-debug-symbols.zip"
`,
  );
  writeExecutable(
    join(binaries, "unzip"),
    "#!/bin/sh\nprintf '\\306\\037\\274\\003\\301\\003\\031\\037bundle'\n",
  );

  const previousArch = process.env.E2E_ANDROID_ARCH;
  const previousPath = process.env.PATH;
  process.env.E2E_ANDROID_ARCH = "x86_64";
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    await buildAndroid({
      cleanup: { add() {} },
      javaHome: "/controlled/temurin-17",
      root: directory,
      workers: "2",
    });
  } finally {
    if (previousArch === undefined) delete process.env.E2E_ANDROID_ARCH;
    else process.env.E2E_ANDROID_ARCH = previousArch;
    process.env.PATH = previousPath;
  }

  const [nodeEnvironment, gradleUserHome, argumentsLine] = readFileSync(commandLog, "utf8")
    .trim()
    .split("\n");
  assert.equal(nodeEnvironment, "production");
  assert.equal(gradleUserHome, join(directory, ".e2e-cache/gradle"));
  assert.match(argumentsLine, /^app:assembleRelease\b/);
  assert.match(argumentsLine, /-Dorg\.gradle\.java\.home=\/controlled\/temurin-17/);
  assert.match(argumentsLine, /-PreactNativeArchitectures=x86_64/);
  assert.doesNotMatch(argumentsLine, /assembleDebug/);
  assert.equal(
    androidBuildArtifact(directory),
    join(directory, "android/app/build/outputs/apk/release/app-release.apk"),
  );
  assert.deepEqual(androidBuildSidecars(directory), [
    join(
      directory,
      "android/app/build/generated/sourcemaps/react/release/index.android.bundle.map",
    ),
    join(
      directory,
      "android/app/build/outputs/native-debug-symbols/release/native-debug-symbols.zip",
    ),
  ]);
});

test("Android Release builds reject configuration in the runner-owned Gradle home", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-android-gradle-home-");
  const androidDirectory = join(directory, "android");
  const gradleHome = join(directory, ".e2e-cache/gradle");
  mkdirSync(androidDirectory, { recursive: true });
  mkdirSync(gradleHome, { recursive: true });
  writeFileSync(join(gradleHome, "gradle.properties"), "org.gradle.java.home=/wrong/jdk\n");
  writeExecutable(join(androidDirectory, "gradlew"), "#!/bin/sh\nexit 0\n");

  await assert.rejects(
    buildAndroid({
      cleanup: { add() {} },
      javaHome: "/controlled/temurin-17",
      root: directory,
      workers: "2",
    }),
    /Runner-owned Gradle home contains build configuration.*gradle\.properties/,
  );
});

test("Android Release builds reject an empty native debug symbols archive", async (t) => {
  const directory = createTemporaryTestDirectory(t, "plogkit-android-empty-native-symbols-");
  const androidDirectory = join(directory, "android");
  const binaries = join(directory, "bin");
  mkdirSync(androidDirectory);
  mkdirSync(binaries);
  writeExecutable(
    join(androidDirectory, "gradlew"),
    `#!/bin/sh
mkdir -p "${directory}/android/app/build/outputs/apk/release"
printf '%s' apk > "${directory}/android/app/build/outputs/apk/release/app-release.apk"
mkdir -p "${directory}/android/app/build/generated/sourcemaps/react/release"
printf '%s' source-map > "${directory}/android/app/build/generated/sourcemaps/react/release/index.android.bundle.map"
mkdir -p "${directory}/android/app/build/outputs/native-debug-symbols/release"
: > "${directory}/android/app/build/outputs/native-debug-symbols/release/native-debug-symbols.zip"
`,
  );
  writeExecutable(
    join(binaries, "unzip"),
    "#!/bin/sh\nprintf '\\306\\037\\274\\003\\301\\003\\031\\037bundle'\n",
  );

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    await assert.rejects(
      buildAndroid({
        cleanup: { add() {} },
        javaHome: "/controlled/temurin-17",
        root: directory,
        workers: "2",
      }),
      /Android Release native debug symbols are missing or empty/,
    );
  } finally {
    process.env.PATH = previousPath;
  }
});

test("standalone launch does not pass a development server URL", () => {
  const launchFlow = readFileSync(join(root, "e2e/subflows/launch-app.yaml"), "utf8");
  assert.doesNotMatch(launchFlow, /initialUrl|localhost:8081|10\.0\.2\.2:8081/);
  assert.equal((launchFlow.match(/launchApp:/g) ?? []).length, 1);
  assert.equal((launchFlow.match(/clearState: true/g) ?? []).length, 1);
  assert.match(launchFlow, /permissions:\s*\n\s+all: unset/);
});
