import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: ["**/.next/**", "dist/**", "node_modules/**", "**/next-env.d.ts", "apps/web/public/monaco/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
);
