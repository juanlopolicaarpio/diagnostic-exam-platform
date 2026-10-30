import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build output and generated reports are not application code.
  globalIgnores([
    'dist',
    'reports',
    '**/*.min.js',
  ]),

  // The app itself: browser globals, React rules on.
  {
    files: ['src/**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // Warnings, not errors — deliberate calls, each with a reason:
      //
      // set-state-in-effect: fires on the "reset derived state when the input
      //   changes" pattern (visualContent resetting on a new asset, ExamBuilder
      //   clearing the active passage on subject change). The idiomatic fix is a
      //   `key` prop or deriving during render, which is a real refactor of the
      //   render path for every question in the bank. Tracked as tech debt; not
      //   worth destabilising rendering for a lint rule.
      'react-hooks/set-state-in-effect': 'warn',
      //
      // only-export-components: a dev-experience rule about Fast Refresh
      //   granularity. mathContent/mathParser2/visualContent deliberately export
      //   both components and the pure helpers that back them. Zero runtime or
      //   production impact.
      'react-refresh/only-export-components': 'warn',
      //
      // no-useless-escape: all 13 hits are `\-` and `\[` inside the math
      //   tokeniser's character classes, where the explicit escape documents
      //   intent and guards against someone later reordering the class. Purely
      //   stylistic; the escapes are harmless.
      'no-useless-escape': 'warn',
    },
  },
])
