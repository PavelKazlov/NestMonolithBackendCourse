// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn'
    },
  },
  {
    // В тестах `expect.any(...)`, `res.json()` и jest-моки типизированы как `any`.
    // Строгие правила про any там дают только шум, поэтому отключаем их для тестов.
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      // `expect(mock.method).toHaveBeenCalled()` — штатный приём Jest, а не
      // потеря `this`: метод не вызывается, а проверяется как объект-мок.
      '@typescript-eslint/unbound-method': 'off',
      // `res.json()` в e2e возвращает any: аргументы из ответа неизбежно any.
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);