import typescriptEslint from '@typescript-eslint/eslint-plugin'
import jest from 'eslint-plugin-jest'
import prettier from 'eslint-plugin-prettier'
import unusedImports from 'eslint-plugin-unused-imports'
import globals from 'globals'
import tsParser from '@typescript-eslint/parser'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import js from '@eslint/js'
import { FlatCompat } from '@eslint/eslintrc'
import sonarjs from 'eslint-plugin-sonarjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
})

export default [
  ...compat.extends(
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
    'plugin:prettier/recommended',
  ),
  {
    plugins: {
      '@typescript-eslint': typescriptEslint,
      jest,
      prettier,
      'unused-imports': unusedImports,
      sonarjs,
    },
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },

      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.json'], // 👈 Add this line
        tsconfigRootDir: __dirname,
      },
    },

    rules: {
      'no-redeclare': ['warn'],
      'no-console': ['error'],
      'no-unused-vars': 'off',
      'no-irregular-whitespace': 'warn',
      'unused-imports/no-unused-imports': 'error',

      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],

      '@typescript-eslint/no-var-requires': 'off',

      'sort-imports': [
        'error',
        {
          ignoreCase: true,
          ignoreDeclarationSort: true,
          ignoreMemberSort: false,
          memberSyntaxSortOrder: ['none', 'all', 'multiple', 'single'],
        },
      ],

      'prettier/prettier': ['error'],
      '@typescript-eslint/explicit-function-return-type': 0,
      '@typescript-eslint/explicit-member-accessibility': 0,
      '@typescript-eslint/indent': 0,
      '@typescript-eslint/member-delimiter-style': 0,
      '@typescript-eslint/no-explicit-any': 0,
      '@typescript-eslint/no-use-before-define': 'error',
      '@typescript-eslint/no-non-null-assertion': 0,
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-floating-promises': 'error',

      'sonarjs/cognitive-complexity': ['error', 15],

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      curly: ['error', 'multi-line'],
      indent: 'off',
      radix: 0,
      'no-var': 'error',
      'no-multi-spaces': 'error',
      'space-in-parens': 'error',
      'no-multiple-empty-lines': 'error',
      'prefer-const': 'error',
      'no-use-before-define': 'error',
      'no-return-await': 'error',
      'max-len': 'off',
      'no-unused-expressions': 'error',
      'no-prototype-builtins': 'error',
      'no-extra-boolean-cast': 'error',
      'no-undefined': 0,
      'no-return-assign': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-sequences': 'error',
    },
  },
]
