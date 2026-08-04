/** @type {import('jest').Config} */
module.exports = {
  ...require("./jest.render.config"),
  testMatch: ["<rootDir>/render-tests/renderMeasurement.measure.js"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  testTimeout: 600_000,
};
