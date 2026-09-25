import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Lint mínimo del frontend (H-20): dependencias de los hooks de React.
 *
 * Los tipos ya los comprueba `tsc`. `typescript-eslint` se usa únicamente como parser de
 * TS/TSX; no se activa ningún conjunto de reglas general. Los avisos cuentan como fallo
 * (`--max-warnings 0`).
 *
 * `react-hooks/rules-of-hooks` es error (H-34): un hook condicional o después de un `return`
 * rompe en ejecución («Rendered more hooks…»), como pasó en `SearchResultsPage` (H-25).
 */
export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
