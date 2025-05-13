export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "jsdom",
  setupFiles: ["./test/jest.setup.ts"],
  roots: ["./test"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { useESM: true }],
  },
  extensionsToTreatAsEsm: [".ts"],
  globals: {
    "ts-jest": {
      useESM: true,
    },
  },
};
