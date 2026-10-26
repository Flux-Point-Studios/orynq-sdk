module.exports = {
  root: true,
  env: { node: true, browser: true, es2022: true },
  parser: "@typescript-eslint/parser",
  parserOptions: { sourceType: "module", ecmaVersion: 2022 },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended"],
  // Match the existing midnight-prover lint scope; tests are verified by Vitest.
  ignorePatterns: ["**/dist/**", "**/node_modules/**", "**/__tests__/**", "**/*.test.ts"],
  rules: {
    // TypeScript checks names and declarations; use its syntax-aware lint rules.
    "no-undef": "off",
    "no-unused-vars": "off",
    "no-redeclare": "off",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-redeclare": "error",
  },
};
