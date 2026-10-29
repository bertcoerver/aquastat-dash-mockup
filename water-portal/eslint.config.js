// ESLint, for what the type checker doesn't catch (a promise dropped on the floor, a
// comma expression, an unneeded assertion…): `npm run lint`. Style is left to the editor.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "public/", "scripts/", "patches/"] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // The modules' APIs are closures returning objects of functions (initX()), with no
      // `this`: taking a function out of one is fine.
      "@typescript-eslint/unbound-method": "off",
      // JSON from fetch and deck.gl's picking info come as `any`; narrowed where used.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // Arrays of numbers in template literals make keys ("1,2").
      "@typescript-eslint/restrict-template-expressions": ["error", { allowArray: true }],
    },
  },
);
