## Status
`continue`

## Size
Size: normal

## Assumptions
- The user wants a general bug hunt and fix cycle across the codebase.
- "busca bugs y arreglalos" implies running tests, static analysis, or checking for obvious errors/panics, and fixing any discovered issues.
- Since run mode is automatic, we proceed directly with standard static analysis/testing to find and fix bugs.

## Non-blocking decisions
- Will scan existing tests and run them to see if any are failing.
- Will check code style / compiler warnings / linter errors.

## Blocking questions
None.
