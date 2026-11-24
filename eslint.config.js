import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "tools/**", "poc/**", "graphify-out/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.cjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    // CommonJS scripts (Electron entry points such as scripts/video-frames.cjs) use require and module.
    files: ["**/*.cjs"],
    languageOptions: {
      globals: {
        require: "readonly",
        module: "writable",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        Buffer: "readonly",
      },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // A hanging network drive must not block the core's main thread (#65, #185).
    files: ["packages/core/src/**/*.ts"],
    ignores: ["**/*.test.ts", "packages/core/src/test/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["node:fs", "fs"].map((name) => ({
            name,
            importNames: ["statSync", "lstatSync", "existsSync", "readFileSync", "readdirSync", "accessSync"],
            message:
              "Kein synchrones fs im Core-Hauptthread: node:fs/promises mit Zeitlimit (hängende Netzlaufwerke, #65)",
          })),
        },
      ],
    },
  },
);
