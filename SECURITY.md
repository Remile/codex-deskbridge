# Security Policy

Only the latest released minor version receives security fixes while the project is in `0.x` development.

Do not open a public issue containing credentials, private task content, or an exploit against a deployed bot. Contact the repository maintainers through a private security advisory. Include the affected version, impact, reproduction steps with synthetic data, and a proposed mitigation when available.

Deployment guidance:

- Run the bridge as a dedicated local user when possible.
- Keep IM allowlists narrow and validate the native sender on every message and card action.
- Keep Codex sandbox and approval settings restrictive. Implement approval UI before enabling remote approval.
- Bind optional HTTP control endpoints to loopback and protect them with a separate random token.
- Never store IM bot credentials, Codex credentials, task transcripts, downloaded attachments, or local state databases in the repository.
- Treat task output as untrusted display data. Escape platform-specific markup and validate links and local media paths.

