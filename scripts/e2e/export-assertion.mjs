import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { log } from "./runtime.mjs";

const defaultCloseTimeoutMs = 5000;

function countNewPhotoResources(before, after) {
  return [...after].filter((resource) => !before.has(resource)).length;
}

export function assessPhotoResourceDelta(before, after, expected) {
  const observed = countNewPhotoResources(before, after);
  if (observed > expected) {
    throw new Error(
      `Expected exactly ${expected} new system photo resources, but observed ${observed}.`,
    );
  }
  return observed === expected ? after : null;
}

export function createPerExportPhotoResourceAssessment(before) {
  let expectedExport = 1;
  return (exportIndex, after) => {
    if (exportIndex !== expectedExport) {
      throw new Error(
        `Expected photo assertion for export ${expectedExport}, but received export ${exportIndex}.`,
      );
    }
    const result = assessPhotoResourceDelta(before, after, exportIndex);
    if (result !== null) expectedExport += 1;
    return result;
  };
}

function listen(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    const reject = (error) => rejectPromise(error);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

function waitForDelay(delayMs, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(finish, delayMs);
    function finish() {
      signal.removeEventListener("abort", abort);
      resolvePromise();
    }
    function abort() {
      clearTimeout(timeout);
      const error = new Error("Export assertion bridge is closing.");
      error.code = "E2E_EXPORT_ASSERTION_ABORTED";
      rejectPromise(error);
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function waitForExport(check, timeoutMs, description, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) {
      const error = new Error("Export assertion bridge is closing.");
      error.code = "E2E_EXPORT_ASSERTION_ABORTED";
      throw error;
    }
    const value = check();
    if (value) return value;
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await waitForDelay(Math.min(500, remainingMs), signal);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export async function startExportAssertionBridge({
  beforePhotoResources,
  capturePhotoResources,
  closeTimeoutMs = defaultCloseTimeoutMs,
  device,
  exportTimeoutMs = 10000,
}) {
  const assessExport = createPerExportPhotoResourceAssessment(beforePhotoResources);
  const activeRequests = new Set();
  const requestControllers = new Set();
  const token = randomUUID();
  const server = createServer((request, response) => {
    const exportMatch = request.url?.match(new RegExp(`^/${token}/(\\d+)$`));
    if (request.method !== "POST" || !exportMatch) {
      response.writeHead(404).end("Not found.");
      return;
    }
    const exportIndex = Number.parseInt(exportMatch[1], 10);
    const controller = new AbortController();
    requestControllers.add(controller);
    response.once("close", () => {
      if (!response.writableFinished) controller.abort();
    });
    let activeRequest;
    activeRequest = waitForExport(
      () => assessExport(exportIndex, capturePhotoResources(device)),
      exportTimeoutMs,
      `${device.platform} export ${exportIndex} to add exactly 1 system photo resource`,
      controller.signal,
    )
      .then((after) => {
        log(
          device.platform,
          `Export ${exportIndex} added exactly 1 new system photo identity ` +
            `(${beforePhotoResources.size} before, ${after.size} after).`,
        );
        if (!response.destroyed) response.writeHead(204).end();
      })
      .catch((error) => {
        if (!response.destroyed) {
          response
            .writeHead(409, {
              Connection: "close",
              "Content-Type": "text/plain; charset=utf-8",
            })
            .end(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        activeRequests.delete(activeRequest);
        requestControllers.delete(controller);
      });
    activeRequests.add(activeRequest);
  });

  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Unable to determine the E2E flow bridge address.");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    close: async () => {
      for (const controller of requestControllers) controller.abort();
      let timeout;
      const closed = new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      });
      const requestsFinished = Promise.allSettled([...activeRequests]);
      const deadline = new Promise((_, rejectPromise) => {
        timeout = setTimeout(() => {
          server.closeAllConnections();
          const error = new Error(
            `E2E export assertion bridge did not close within ${closeTimeoutMs} ms.`,
          );
          error.code = "E2E_EXPORT_ASSERTION_CLOSE_TIMEOUT";
          rejectPromise(error);
        }, closeTimeoutMs);
      });
      try {
        await Promise.race([Promise.all([closed, requestsFinished]), deadline]);
      } finally {
        clearTimeout(timeout);
      }
    },
    environment: {
      PLOGKIT_EXPORT_ASSERTION_URL: `${baseUrl}/${token}`,
    },
  };
}
