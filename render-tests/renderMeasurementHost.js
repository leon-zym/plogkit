import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { cpus, freemem, loadavg } from "node:os";
import { basename, posix } from "node:path";

function defaultRunPs() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,%cpu=,command="], {
    encoding: "utf8",
  });
}

function defaultRunThermal() {
  return execFileSync("pmset", ["-g", "therm"], { encoding: "utf8" });
}

function defaultRunMemoryPressure() {
  return execFileSync("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], {
    encoding: "utf8",
  });
}

function defaultRunPowerSource() {
  return execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" });
}

function defaultRunPowerSettings() {
  return execFileSync("pmset", ["-g"], { encoding: "utf8" });
}

function parseProcessRows(output) {
  if (typeof output !== "string") throw new Error("ps output must be text");
  const lines = output
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("ps output must contain a process row");
  return lines.map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
    if (match === null) throw new Error("ps output contains a malformed process row");
    const row = {
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      cpuPercent: Number(match[3]),
      command: match[4],
    };
    if (!Number.isFinite(row.cpuPercent)) throw new Error("ps output contains invalid CPU usage");
    return row;
  });
}

function ancestorPids(rows, selfPid) {
  const parentByPid = new Map(rows.map(({ pid, parentPid }) => [pid, parentPid]));
  const ancestors = new Set([selfPid]);
  let candidate = selfPid;
  while (parentByPid.has(candidate)) {
    candidate = parentByPid.get(candidate);
    if (candidate <= 1 || ancestors.has(candidate)) break;
    ancestors.add(candidate);
  }
  return ancestors;
}

function commandTokens(command) {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
    token.replace(/^(["'])(.*)\1$/, "$2"),
  );
}

function safeExecutable(command) {
  return basename(commandTokens(command)[0] ?? "");
}

function safeFinding(category, row) {
  return {
    category,
    pid: row.pid,
    cpuPercent: row.cpuPercent,
    executable: safeExecutable(row.command),
  };
}

const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh"]);
const JAVA_GRADLE_MAIN_CLASSES = new Set([
  "org.gradle.wrapper.GradleWrapperMain",
  "org.gradle.launcher.daemon.bootstrap.GradleDaemon",
]);
const JAVA_OPTIONS_WITH_VALUE = new Set([
  "-cp",
  "-classpath",
  "--class-path",
  "-p",
  "--module-path",
  "--upgrade-module-path",
  "--add-modules",
  "--enable-native-access",
  "--limit-modules",
  "--add-exports",
  "--add-opens",
  "--patch-module",
]);
const JAVA_NON_CLASS_LAUNCH_OPTIONS = new Set(["-jar", "-m", "--module", "--source"]);
const DIRECT_VERIFICATION_EXECUTABLES = new Set([
  "maestro",
  "jest",
  "vitest",
  "tsc",
  "eslint",
  "prettier",
]);
const PACKAGE_MANAGER_EXECUTABLES = new Set(["npm", "yarn", "bun", "pnpm"]);
const NATIVE_BUILD_EXECUTABLES = new Set(["xcodebuild", "clang", "swiftc", "kotlinc"]);

function shellScriptToken(tokens) {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") return tokens[index + 1] ?? null;
    if (token === "-c" || /^-[^-]*c/.test(token)) return null;
    if (token === "-o" || token === "+o" || token === "--rcfile" || token === "--init-file") {
      index += 1;
      continue;
    }
    if (token.startsWith("-") || token.startsWith("+")) continue;
    return token;
  }
  return null;
}

function javaMainClass(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") return args[index + 1] ?? null;
    if (JAVA_NON_CLASS_LAUNCH_OPTIONS.has(token)) return null;
    const optionName = token.startsWith("--") ? token.split("=", 1)[0] : token;
    if (JAVA_OPTIONS_WITH_VALUE.has(optionName)) {
      if (token.includes("=")) continue;
      if (args[index + 1] === undefined) return null;
      index += 1;
      continue;
    }
    if (
      /^(?:-D|-X|-XX:|-javaagent:|-agentlib:|-agentpath:|-splash:)/.test(token) ||
      /^(?:-client|-server|-ea|-enableassertions|-da|-disableassertions|-esa|-enablesystemassertions|-dsa|-disablesystemassertions|--enable-preview)$/.test(
        token,
      )
    ) {
      continue;
    }
    if (token.startsWith("-") || token.startsWith("@")) return null;
    return token;
  }
  return null;
}

function isGradleWorkload(command) {
  const tokens = commandTokens(command);
  const executable = basename(tokens[0] ?? "");
  if (executable === "gradle" || executable === "gradlew") return true;
  if (SHELL_EXECUTABLES.has(executable)) {
    return basename(shellScriptToken(tokens) ?? "") === "gradlew";
  }
  return executable === "java" && JAVA_GRADLE_MAIN_CLASSES.has(javaMainClass(tokens.slice(1)));
}

function isKnownNodeVerificationEntrypoint(token) {
  const path = posix.normalize(token.replaceAll("\\", "/"));
  return [
    /(?:^|\/)node_modules\/(?:jest|jest-cli)\/bin\/jest\.js$/,
    /(?:^|\/)node_modules\/vitest\/(?:vitest\.mjs|dist\/cli\.js)$/,
    /(?:^|\/)node_modules\/typescript\/bin\/tsc$/,
    /(?:^|\/)node_modules\/eslint\/bin\/eslint\.js$/,
    /(?:^|\/)node_modules\/prettier\/bin\/prettier\.(?:cjs|js)$/,
  ].some((pattern) => pattern.test(path));
}

function isExpoCliEntrypoint(token) {
  const path = posix.normalize(token.replaceAll("\\", "/"));
  return /(?:^|\/)node_modules\/(?:expo\/bin\/cli|@expo\/cli\/build\/bin\/cli)$/.test(path);
}

function isMetroCliEntrypoint(token) {
  const path = posix.normalize(token.replaceAll("\\", "/"));
  return /(?:^|\/)node_modules\/metro\/src\/cli\.js$/.test(path);
}

function invokedPackageCommand(args) {
  const [first, second] = args;
  return first === "run" || first === "exec" ? second : first;
}

function nodePackageManagerName(entrypoint) {
  const path = posix.normalize(entrypoint.replaceAll("\\", "/"));
  if (/\/bin\/pnpm(?:\.c?js)?$/.test(path)) return "pnpm";
  if (/\/npm\/bin\/npm-cli\.js$/.test(path)) return "npm";
  if (/\/yarn\/bin\/yarn\.js$/.test(path)) return "yarn";
  return null;
}

function packageManagerToolInvocation(manager, args) {
  const runner = args[0];
  const supported =
    (manager === "npm" && runner === "exec") ||
    (manager === "yarn" && (runner === "exec" || runner === "dlx")) ||
    (manager === "bun" && runner === "x") ||
    (manager === "pnpm" && (runner === "exec" || runner === "dlx"));
  if (!supported) return null;
  const toolIndex = args[1] === "--" ? 2 : 1;
  return { tool: basename(args[toolIndex] ?? ""), args: args.slice(toolIndex + 1) };
}

function npxToolInvocation(args) {
  let toolIndex = 0;
  while (args[toolIndex] === "--yes" || args[toolIndex] === "-y") toolIndex += 1;
  if (args[toolIndex] === "--") toolIndex += 1;
  const tool = basename(args[toolIndex] ?? "");
  return tool === "" ? null : { tool, args: args.slice(toolIndex + 1) };
}

function isPackageManagerVerification(manager, args) {
  const packageCommand = invokedPackageCommand(args);
  const toolInvocation = packageManagerToolInvocation(manager, args);
  if (toolInvocation !== null) {
    if (DIRECT_VERIFICATION_EXECUTABLES.has(toolInvocation.tool)) return true;
    if (toolInvocation.tool === "expo" && toolInvocation.args[0] === "lint") return true;
  }
  if (["npm", "yarn", "bun"].includes(manager)) {
    return /^(?:install|ci|test(?::[\w-]+)?|e2e(?::[\w-]+)?)$/.test(packageCommand ?? "");
  }
  if (manager === "pnpm") {
    return /^(?:install|check|verify|measure(?::[\w-]+)?|test(?::[\w-]+)?|e2e(?::[\w-]+)?|lint|typecheck)$/.test(
      packageCommand ?? "",
    );
  }
  return false;
}

function isTestOrBenchmarkWorkload(command) {
  const tokens = commandTokens(command);
  const executable = basename(tokens[0] ?? "");
  if (DIRECT_VERIFICATION_EXECUTABLES.has(executable)) return true;
  if (executable === "node") {
    const entrypoint = tokens[1];
    const packageManager = entrypoint === undefined ? null : nodePackageManagerName(entrypoint);
    return (
      entrypoint === "--test" ||
      entrypoint?.startsWith("--test=") === true ||
      (entrypoint !== undefined && isKnownNodeVerificationEntrypoint(entrypoint)) ||
      (packageManager !== null && isPackageManagerVerification(packageManager, tokens.slice(2))) ||
      (entrypoint !== undefined && isExpoCliEntrypoint(entrypoint) && tokens[2] === "lint")
    );
  }
  if (executable === "expo") return tokens[1] === "lint";
  if (executable === "npx") {
    const invocation = npxToolInvocation(tokens.slice(1));
    return (
      (invocation !== null && DIRECT_VERIFICATION_EXECUTABLES.has(invocation.tool)) ||
      (invocation?.tool === "expo" && invocation.args[0] === "lint")
    );
  }
  return isPackageManagerVerification(executable, tokens.slice(1));
}

function isExpoBuildAction(action) {
  return /^(?:prebuild|start|run:[\w-]+|build(?::[\w-]+)?|export(?::[\w-]+)?)$/.test(action ?? "");
}

function isExpoBuildWorkload(command) {
  const tokens = commandTokens(command);
  const executable = basename(tokens[0] ?? "");
  if (executable === "expo") return isExpoBuildAction(tokens[1]);
  if (executable === "npx") {
    const invocation = npxToolInvocation(tokens.slice(1));
    return invocation?.tool === "expo" && isExpoBuildAction(invocation.args[0]);
  }
  if (executable === "node") {
    const entrypoint = tokens[1];
    if (entrypoint !== undefined && isExpoCliEntrypoint(entrypoint)) {
      return isExpoBuildAction(tokens[2]);
    }
    const packageManager = entrypoint === undefined ? null : nodePackageManagerName(entrypoint);
    const invocation =
      packageManager === null
        ? null
        : packageManagerToolInvocation(packageManager, tokens.slice(2));
    return invocation?.tool === "expo" && isExpoBuildAction(invocation.args[0]);
  }
  if (!PACKAGE_MANAGER_EXECUTABLES.has(executable)) return false;
  const invocation = packageManagerToolInvocation(executable, tokens.slice(1));
  return invocation?.tool === "expo" && isExpoBuildAction(invocation.args[0]);
}

function isMetroBuildAction(action) {
  return /^(?:start|serve|build|get-dependencies)$/.test(action ?? "");
}

function isMetroBuildWorkload(command) {
  const tokens = commandTokens(command);
  const executable = basename(tokens[0] ?? "");
  if (executable === "metro") return isMetroBuildAction(tokens[1]);
  if (executable === "npx") {
    const invocation = npxToolInvocation(tokens.slice(1));
    return invocation?.tool === "metro" && isMetroBuildAction(invocation.args[0]);
  }
  if (executable === "node") {
    const entrypoint = tokens[1];
    if (entrypoint !== undefined && isMetroCliEntrypoint(entrypoint)) {
      return isMetroBuildAction(tokens[2]);
    }
    const packageManager = entrypoint === undefined ? null : nodePackageManagerName(entrypoint);
    const invocation =
      packageManager === null
        ? null
        : packageManagerToolInvocation(packageManager, tokens.slice(2));
    return invocation?.tool === "metro" && isMetroBuildAction(invocation.args[0]);
  }
  if (!PACKAGE_MANAGER_EXECUTABLES.has(executable)) return false;
  const invocation = packageManagerToolInvocation(executable, tokens.slice(1));
  return invocation?.tool === "metro" && isMetroBuildAction(invocation.args[0]);
}

function xcrunTool(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") return basename(args[index + 1] ?? "");
    if (token === "--find" || token === "-f") return "";
    if (["--sdk", "-sdk", "--toolchain", "-toolchain"].includes(token)) {
      index += 1;
      continue;
    }
    if (
      ["--verbose", "-v", "--no-cache", "-n", "--kill-cache", "-k", "--log", "-l"].includes(token)
    ) {
      continue;
    }
    if (token.startsWith("-")) return "";
    return basename(token);
  }
  return "";
}

function envCommandTokens(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") return args.slice(index + 1);
    if (token === "-u" || token === "--unset") {
      index += 1;
      continue;
    }
    if (
      token === "-i" ||
      token === "--ignore-environment" ||
      token.startsWith("--unset=") ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
    ) {
      continue;
    }
    if (token.startsWith("-")) return [];
    return args.slice(index);
  }
  return [];
}

function isNativeBuildTokens(tokens) {
  const executable = basename(tokens[0] ?? "");
  if (NATIVE_BUILD_EXECUTABLES.has(executable)) return true;
  if (executable === "xcrun") return NATIVE_BUILD_EXECUTABLES.has(xcrunTool(tokens.slice(1)));
  if (executable === "env") return isNativeBuildTokens(envCommandTokens(tokens.slice(1)));
  return false;
}

function isNativeBuildWorkload(command) {
  return isNativeBuildTokens(commandTokens(command));
}

function isPackageManagerBuild(manager, args) {
  const action = args[0] === "run" ? args[1] : args[0];
  return (
    PACKAGE_MANAGER_EXECUTABLES.has(manager) && /^(?:build|start|prebuild)$/.test(action ?? "")
  );
}

function isPackageManagerBuildWorkload(command) {
  const tokens = commandTokens(command);
  const executable = basename(tokens[0] ?? "");
  if (PACKAGE_MANAGER_EXECUTABLES.has(executable)) {
    return isPackageManagerBuild(executable, tokens.slice(1));
  }
  if (executable !== "node") return false;
  const manager = nodePackageManagerName(tokens[1] ?? "");
  return manager !== null && isPackageManagerBuild(manager, tokens.slice(2));
}

function isSimulatorWorkload(command) {
  const executable = safeExecutable(command);
  return (
    executable === "Simulator" ||
    executable === "launchd_sim" ||
    executable === "emulator" ||
    executable.startsWith("qemu-system-")
  );
}

function isIndexingWorkload(command) {
  const executable = safeExecutable(command);
  return ["mdworker", "mdworker_shared", "mds", "mds_stores"].includes(executable);
}

function classifyInterference(rows, selfPid) {
  const ignored = ancestorPids(rows, selfPid);
  const external = rows.filter(({ pid }) => !ignored.has(pid));
  return {
    simulators: external
      .filter(({ command }) => isSimulatorWorkload(command))
      .map((row) => safeFinding("simulator", row)),
    builds: external
      .filter(
        ({ command }) =>
          isGradleWorkload(command) ||
          isExpoBuildWorkload(command) ||
          isMetroBuildWorkload(command) ||
          isNativeBuildWorkload(command) ||
          isPackageManagerBuildWorkload(command),
      )
      .map((row) => safeFinding("build", row)),
    testsOrBenchmarks: external
      .filter(({ command }) => isTestOrBenchmarkWorkload(command))
      .map((row) => safeFinding("test-or-benchmark", row)),
    indexing: external
      .filter(({ cpuPercent, command }) => cpuPercent >= 1 && isIndexingWorkload(command))
      .map((row) => safeFinding("indexing", row)),
  };
}

export function captureHostProcessProbe({ runPs = defaultRunPs, selfPid = process.pid } = {}) {
  try {
    const rows = parseProcessRows(runPs());
    if (!rows.some(({ pid }) => pid === selfPid)) {
      throw new Error("ps output does not contain the measurement process");
    }
    return {
      status: "available",
      detectedInterference: classifyInterference(rows, selfPid),
    };
  } catch {
    return { status: "unavailable", reason: "ps process probe failed" };
  }
}

function parseThermalState(output, logicalCpuCount) {
  const raw = output.trim();
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const explicitWarning = lines.some((line) => {
    if (/thermal_level\s*=\s*[1-9]\d*(?:\D|$)/i.test(line)) return true;
    const limit = line.match(/(?:cpu_)?(?:speed|scheduler)_limit\s*=\s*(\d+)/i);
    if (limit !== null && Number(limit[1]) < 100) return true;
    const availableCpus = line.match(/cpu_available_cpus\s*=\s*(\d+)/i);
    if (availableCpus !== null && Number(availableCpus[1]) === 0) return true;
    return (
      /(?:thermal|performance) warning|cpu power status/i.test(line) &&
      !/^note:\s*no\s+/i.test(line)
    );
  });
  if (explicitWarning) {
    return { status: "warning", raw };
  }
  const noteNominalPatterns = [
    /^note:\s*no thermal warning level has been recorded$/i,
    /^note:\s*no performance warning level has been recorded$/i,
    /^note:\s*no cpu power status has been recorded$/i,
  ];
  const noteNominal =
    lines.length === noteNominalPatterns.length &&
    noteNominalPatterns.every((pattern) => lines.some((line) => pattern.test(line)));
  const numericLinesKnown = lines.every((line) =>
    /^(?:thermal_level|cpu_scheduler_limit|cpu_available_cpus|cpu_speed_limit)\s*=\s*\d+$/i.test(
      line,
    ),
  );
  const availableCpuMatch = raw.match(/cpu_available_cpus\s*=\s*(\d+)/i);
  const numericNominal =
    numericLinesKnown &&
    Number.isInteger(logicalCpuCount) &&
    logicalCpuCount > 0 &&
    /thermal_level\s*=\s*0(?:\D|$)/i.test(raw) &&
    /cpu_scheduler_limit\s*=\s*100(?:\D|$)/i.test(raw) &&
    availableCpuMatch !== null &&
    Number(availableCpuMatch[1]) === logicalCpuCount &&
    /cpu_speed_limit\s*=\s*100(?:\D|$)/i.test(raw);
  if (noteNominal || numericNominal) return { status: "nominal", raw };
  return { status: "unknown", raw };
}

function parseMemoryPressure(output) {
  const raw = output.trim();
  if (!/^\d+$/.test(raw)) return { status: "unknown", raw };
  const level = Number(raw);
  return level === 1 ? { status: "nominal", level, raw } : { status: "warning", level, raw };
}

export function captureHostHealthProbe({
  runThermal = defaultRunThermal,
  runMemoryPressure = defaultRunMemoryPressure,
  logicalCpuCount = cpus().length,
} = {}) {
  let thermal;
  try {
    thermal = parseThermalState(runThermal(), logicalCpuCount);
  } catch {
    thermal = { status: "unknown", reason: "thermal probe failed" };
  }
  let memoryPressure;
  try {
    memoryPressure = parseMemoryPressure(runMemoryPressure());
  } catch {
    memoryPressure = { status: "unknown", reason: "memory-pressure probe failed" };
  }
  return { thermal, memoryPressure };
}

export function captureHostState(
  root,
  {
    now = () => new Date().toISOString(),
    getLoadAverage = loadavg,
    getFreeMemory = freemem,
    statFilesystem = statfsSync,
    runPowerSource = defaultRunPowerSource,
    runPowerSettings = defaultRunPowerSettings,
    captureProcessProbe = captureHostProcessProbe,
    captureHealthProbe = captureHostHealthProbe,
  } = {},
) {
  const filesystem = statFilesystem(root);
  let powerState;
  try {
    const sourceOutput = runPowerSource();
    const settingsOutput = runPowerSettings();
    const source = /drawing from ['"]AC Power['"]/i.test(sourceOutput)
      ? "ac"
      : /drawing from ['"]Battery Power['"]/i.test(sourceOutput)
        ? "battery"
        : null;
    const lowPowerModeMatch = settingsOutput.match(/\blowpowermode\s+(\d+)\b/i);
    if (source === null || lowPowerModeMatch === null) {
      powerState = { status: "unknown", reason: "power state could not be parsed" };
    } else {
      powerState = {
        status: "available",
        source,
        lowPowerMode: Number(lowPowerModeMatch[1]) !== 0,
      };
    }
  } catch {
    powerState = { status: "unavailable", reason: "pmset power probe failed" };
  }
  const hostLoadAverage = getLoadAverage();
  return {
    capturedAt: now(),
    loadAverage: {
      oneMinute: hostLoadAverage[0],
      fiveMinutes: hostLoadAverage[1],
      fifteenMinutes: hostLoadAverage[2],
    },
    freeMemoryBytes: getFreeMemory(),
    availableStorageBytes: filesystem.bavail * filesystem.bsize,
    powerState,
    processProbe: captureProcessProbe(),
    healthProbe: captureHealthProbe(),
  };
}

function processProbeReasons(processProbe) {
  if (processProbe.status !== "available") return ["host-process-probe-unavailable"];
  return Object.values(processProbe.detectedInterference).some((findings) => findings.length > 0)
    ? ["concurrent-host-workload-detected"]
    : [];
}

function healthProbeReasons(healthProbe) {
  const reasons = [];
  if (healthProbe.thermal.status === "warning") reasons.push("host-thermal-warning");
  if (healthProbe.thermal.status === "unknown") reasons.push("host-thermal-probe-unknown");
  if (healthProbe.memoryPressure.status === "warning") {
    reasons.push("host-memory-pressure-warning");
  }
  if (healthProbe.memoryPressure.status === "unknown") {
    reasons.push("host-memory-pressure-probe-unknown");
  }
  return reasons;
}

function powerProbeReasons(powerState) {
  if (powerState.status !== "available") return ["host-power-state-unknown"];
  const reasons = [];
  if (powerState.source !== "ac") reasons.push("host-on-battery-power");
  if (powerState.lowPowerMode) reasons.push("host-low-power-mode-enabled");
  return reasons;
}

export function hostStateExecutionReadiness(state) {
  const retryableReasons = [
    ...processProbeReasons(state.processProbe),
    ...healthProbeReasons(state.healthProbe),
  ];
  const failFastReasons = powerProbeReasons(state.powerState);
  const reasons = [...retryableReasons, ...failFastReasons];
  return { ready: reasons.length === 0, reasons, retryableReasons, failFastReasons };
}

export function createHostEligibility({
  profile,
  dirty,
  isolationConfirmed,
  renderVerificationReceiptValid,
  processProbe,
  healthProbe,
  powerState,
  deferRecoverableHostChecks = false,
}) {
  const reasons = [];
  if (profile !== "full") reasons.push("smoke-profile-is-diagnostic-only");
  if (dirty) reasons.push("worktree-is-dirty");
  if (!isolationConfirmed) reasons.push("host-isolation-not-explicitly-confirmed");
  if (!renderVerificationReceiptValid) reasons.push("render-verification-receipt-invalid");
  if (!deferRecoverableHostChecks) {
    reasons.push(...processProbeReasons(processProbe));
    reasons.push(...healthProbeReasons(healthProbe));
  }
  reasons.push(...powerProbeReasons(powerState));
  return {
    eligible: reasons.length === 0,
    resultClass: reasons.length === 0 ? "engineering-baseline" : "diagnostic",
    reasons,
    isolationConfirmed,
    renderVerificationReceiptValid,
  };
}

export function mergeSampleHostEligibilityReasons(initialReasons, before, after) {
  return [
    ...new Set([
      ...initialReasons,
      ...processProbeReasons(before.processProbe),
      ...healthProbeReasons(before.healthProbe),
      ...powerProbeReasons(before.powerState),
      ...processProbeReasons(after.processProbe),
      ...healthProbeReasons(after.healthProbe),
      ...powerProbeReasons(after.powerState),
    ]),
  ];
}
