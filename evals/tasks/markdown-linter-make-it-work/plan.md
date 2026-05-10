# the markdown linter feels broken on our docs

we vendored a tiny markdown linter at `vendor/markdown-linter/` to keep
our project documentation honest. it works fine on the example fixtures
inside its own `test/` folder — `npm test` (cwd `vendor/markdown-linter/`)
goes green — but when i point it at our actual `docs/` directory it
barely catches anything.

i have rules in there for trailing whitespace, bare urls, list
indentation, code-fence language tags, and frontmatter — but on the real
docs almost none of them trigger. could you take a look and make it
actually work on our files?

run it like:

```
node vendor/markdown-linter/src/cli.js vendor/markdown-linter/docs/
```

the existing tests in `vendor/markdown-linter/test/` should still pass
when you're done.
