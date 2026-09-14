import tseslint from "typescript-eslint";

// Thresholds at 0 so every block and callback is reported with its depth.
export default tseslint.config({
  files: ["**/*.ts"],
  languageOptions: { parser: tseslint.parser },
  rules: {
    "max-depth": ["warn", 0],
    "max-nested-callbacks": ["warn", 0],
  },
});
