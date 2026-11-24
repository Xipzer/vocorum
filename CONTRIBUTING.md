# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Developer Certificate of Origin

Every commit must be signed off. By signing off you certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): that you
wrote the change or have the right to submit it under this project's licence.
There is no CLA.

```bash
git commit -s -m "Explain the change"
```

This adds a line like `Signed-off-by: Your Name <you@example.com>` to the commit.

## Before you open a pull request

- `pnpm typecheck` and `pnpm test` pass.
- New behaviour has a test. UI changes come with a screenshot.
- No secrets, personal paths, hostnames or tokens in code, tests or commit messages.
- Changes to `vendor/discord-digital-twin` stay MIT-licensed; note them in `NOTICE`.

## Security issues

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
