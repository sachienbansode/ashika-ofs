import globals from "globals";
export default [
  { ignores: ["node_modules/**", ".lintmods/**", "qa/node_modules/**"] },
  { files: ["routes/**/*.js","lib/**/*.js","db/**/*.js","middleware/**/*.js","*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "commonjs", globals: { ...globals.node } },
    rules: { "no-undef": "error" } },
  { files: ["public/**/*.js"],
    languageOptions: { ecmaVersion: 2018, sourceType: "script",
      globals: { ...globals.browser, OFS_BIDMATH: "readonly", OFS_RULES: "readonly",
                 OFS_CONFIG: "readonly", OFS_RULESVIEW: "readonly" } },
    rules: { "no-undef": "error" } }
];
