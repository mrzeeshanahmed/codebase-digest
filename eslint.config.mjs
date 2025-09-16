import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [{
    files: ["**/*.ts"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint,
    },

    languageOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",
        // Prevent accidental direct named imports of similar helpers that change UX/flow.
        // Prefer namespaced imports from `src/utils` barrel: `internalErrors` and `interactiveMessages`.
        // Examples that should be avoided:
        //   import { showUserError } from '../utils/userMessages';
        //   import { logUserError } from '../utils/errors';
        // Use instead:
        //   import { interactiveMessages } from '../utils';
        //   interactiveMessages.showUserError(...)
        // or
        //   import { internalErrors } from '../utils';
        //   internalErrors.logUserError(...)
        "no-restricted-syntax": [
            "error",
            {
                "selector": "ImportDeclaration[source.value='../utils/userMessages']",
                "message": "Import from 'src/utils/userMessages' directly is discouraged. Use the utils barrel: import { interactiveMessages } from '../utils'"
            },
            {
                "selector": "ImportDeclaration[source.value='../utils/errors']",
                "message": "Import from 'src/utils/errors' directly is discouraged. Use the utils barrel: import { internalErrors } from '../utils'"
            }
        ],
    },
}];