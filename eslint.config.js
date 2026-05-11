import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist', 'node_modules', 'coverage'],
  },
  js.configs.recommended,
  // Lightweight, non-type-checked rules for everything (root config files included)
  {
    files: ['**/*.{ts,mts,cts,js,mjs,cjs}'],
    extends: [...tseslint.configs.recommended],
  },
  // Type-checked rules layered on top — only for src/, since that's what tsconfig.json covers
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
);
