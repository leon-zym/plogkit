import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { capture } from "./runtime.mjs";

const expoModulesCoreSwiftPrefix = "_$s15ExpoModulesCore";

function symbolsFromNm(output) {
  return new Set(
    output
      .split("\n")
      .map((line) => line.trim().split(/\s+/).at(-1))
      .filter(Boolean),
  );
}

function frameworkBinary(frameworksDirectory, entry) {
  const frameworkName = entry.name.slice(0, -".framework".length);
  const binary = join(frameworksDirectory, entry.name, frameworkName);
  return existsSync(binary) && statSync(binary).isFile() ? { binary, frameworkName } : null;
}

function binaryArchitectures(binary) {
  return capture("xcrun", ["lipo", "-archs", binary], { timeoutMs: 15000 })
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function assertArchitecture(architecture) {
  if (!["arm64", "x86_64"].includes(architecture)) {
    throw new Error(`Unsupported iOS Simulator architecture: ${architecture}.`);
  }
}

function assertArchitectureOnly(binaries, architecture) {
  for (const { architectures, name } of binaries) {
    if (architectures.length !== 1 || architectures[0] !== architecture) {
      throw new Error(
        `${name} must contain only ${architecture} for the iOS Release simulator ` +
          `contract, but contains: ${architectures.join(" ") || "none"}.`,
      );
    }
  }
}

function inspectConsumer(binary, name, coreExports, architecture) {
  const architectures = binaryArchitectures(binary);
  if (!architectures.includes(architecture)) {
    throw new Error(`${name} does not contain the required ${architecture} simulator slice.`);
  }
  const requirements = [
    ...symbolsFromNm(
      capture("xcrun", ["nm", "-arch", architecture, "-u", binary], {
        timeoutMs: 15000,
      }),
    ),
  ].filter((symbol) => symbol.startsWith(expoModulesCoreSwiftPrefix));
  const missing = requirements.filter((symbol) => !coreExports.has(symbol));
  if (missing.length > 0) {
    throw new Error(
      `${name} requires ${missing.length} ExpoModulesCore ` +
        `symbol${missing.length === 1 ? "" : "s"} missing from the embedded ` +
        `ExpoModulesCore framework:\n${missing.join("\n")}`,
    );
  }
  return { architectures, name, requirements };
}

export function assertIosExpoModulesCoreAbi(app, architecture = "arm64") {
  assertArchitecture(architecture);
  const appBinary = join(app, "PlogKit");
  if (!existsSync(appBinary) || !statSync(appBinary).isFile()) {
    throw new Error(`iOS Release is missing its PlogKit executable: ${appBinary}`);
  }
  const frameworksDirectory = join(app, "Frameworks");
  const coreBinary = join(frameworksDirectory, "ExpoModulesCore.framework", "ExpoModulesCore");
  if (!existsSync(coreBinary) || !statSync(coreBinary).isFile()) {
    throw new Error(`iOS Release is missing its embedded ExpoModulesCore binary: ${coreBinary}`);
  }

  const coreArchitectures = binaryArchitectures(coreBinary);
  if (!coreArchitectures.includes(architecture)) {
    throw new Error(
      `ExpoModulesCore does not contain the required ${architecture} simulator slice.`,
    );
  }
  const coreExports = symbolsFromNm(
    capture("xcrun", ["nm", "-arch", architecture, "-gU", coreBinary], {
      timeoutMs: 15000,
    }),
  );
  let consumers = 0;
  let requiredSymbols = 0;
  const appConsumer = inspectConsumer(appBinary, "PlogKit", coreExports, architecture);
  const inspectedBinaries = [
    appConsumer,
    { architectures: coreArchitectures, name: "ExpoModulesCore" },
  ];
  if (appConsumer.requirements.length > 0) {
    consumers += 1;
    requiredSymbols += appConsumer.requirements.length;
  }
  for (const entry of readdirSync(frameworksDirectory, { withFileTypes: true })) {
    if (!entry.name.endsWith(".framework")) continue;
    if (!entry.isDirectory()) {
      throw new Error(`iOS Release framework is not a directory: ${entry.name}`);
    }
    const framework = frameworkBinary(frameworksDirectory, entry);
    if (!framework) {
      throw new Error(
        `${entry.name} matched the embedded framework contract, but its ` +
          "same-named executable cannot be inspected.",
      );
    }
    if (framework.frameworkName === "ExpoModulesCore") continue;
    const consumer = inspectConsumer(
      framework.binary,
      framework.frameworkName,
      coreExports,
      architecture,
    );
    inspectedBinaries.push(consumer);
    if (consumer.requirements.length === 0) continue;
    consumers += 1;
    requiredSymbols += consumer.requirements.length;
  }
  if (consumers === 0 || requiredSymbols === 0) {
    throw new Error(
      "iOS Release did not expose any native imports to validate against ExpoModulesCore.",
    );
  }
  assertArchitectureOnly(inspectedBinaries, architecture);
  return { consumers, requiredSymbols };
}
