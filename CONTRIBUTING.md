Contributing Guidelines

Short guideline: Prefer explicit, namespaced imports for utils to avoid mixing interactive prompts with non-interactive logging helpers.

Why
- There are two related-but-different helper modules:
  - `src/utils/errors.ts` — non-interactive logging helpers (logUserError, logUserWarning) and Error classes. Use these when you only need to log or show a non-blocking notification.
  - `src/utils/userMessages.ts` — interactive helpers (showUserError, showUserWarning) that present prompts and return user actions. Use these only when your code needs to branch on a user's choice.

Preferred import pattern
- Use the utils barrel to make imports explicit and namespaced:

  import { internalErrors, interactiveMessages } from '../utils';

  // Non-interactive logging
  internalErrors.logUserError('message', 'details');

  // Interactive prompt
  const res = await interactiveMessages.showUserError(err);

What to avoid
- Do not import `showUserError`, `showUserWarning`, `logUserError`, or `logUserWarning` directly from the individual modules. This can lead to accidentally using an interactive function in a non-interactive context and change UX/control flow.

Linting
- The repository includes an ESLint rule that warns if you import from `src/utils/errors` or `src/utils/userMessages` directly. Please follow the guidance above when fixing lint warnings.

Thanks for contributing!



