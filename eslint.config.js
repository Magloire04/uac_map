/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import js from '@eslint/js';
import globals from 'globals';
import security from 'eslint-plugin-security';
import noUnsanitized from 'eslint-plugin-no-unsanitized';

export default [
  { ignores: ['node_modules/', 'data/', 'coverage/'] },
  js.configs.recommended,
  security.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      // Règles de sécurité bloquantes (standard ASIN : linter avec règles de sécurité en mode erreur).
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-unsafe-regex': 'error',
      'security/detect-non-literal-regexp': 'error',
      'security/detect-child-process': 'error',
      'security/detect-buffer-noassert': 'error',
      'security/detect-pseudoRandomBytes': 'error',
      // Écart documenté (docs/decisions.md) : règle très bruyante sur l'accès par index (tableau[index]),
      // sans rapport avec une donnée externe dans ce projet.
      'security/detect-object-injection': 'off',
      // Écart documenté : les chemins de fichiers viennent de la configuration serveur, jamais d'une requête HTTP.
      'security/detect-non-literal-fs-filename': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    files: ['server/**/*.js', 'scripts/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: globals.browser },
    plugins: { 'no-unsanitized': noUnsanitized },
    rules: {
      // Toute insertion HTML doit passer par le gabarit html`...` (public/safeHtml.js) : protège du XSS (OWASP A03).
      'no-unsanitized/method': ['error', { escape: { taggedTemplates: ['html'] } }],
      'no-unsanitized/property': ['error', { escape: { taggedTemplates: ['html'], methods: ['escapeHtml'] } }],
    },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: ['shared/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
];
