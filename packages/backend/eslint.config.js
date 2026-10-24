import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
	{
		ignores: [
			"node_modules/**",
			".wrangler/**",
			"dist/**",
			"coverage/**",
			"worker-configuration.d.ts",
			"public/**",
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	// Must stay last so it disables stylistic rules that conflict with Prettier.
	prettier,
	{
		files: ["**/*.ts"],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: "module",
		},
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	},
);
