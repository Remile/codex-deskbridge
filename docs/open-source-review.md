# Open-source review

This review covers the repository contents, not ignored deployment data.

## Cleared in the current tree

- No company-specific task names, repositories, business workflow descriptions, or production incident transcripts remain in publishable source and documentation.
- Real Feishu state, task mappings, logs, media, and local database files remain under ignored `.local/` and `work/` directories.
- The runtime uses the documented Codex App Server protocol. Private ChatGPT Desktop IPC calls and direct Codex state database/history readers were removed.
- The npm package has an explicit file allowlist and a pre-release content scan.
- The project uses a neutral package and service name and includes a non-affiliation trademark notice.
- No third-party source code is vendored. `lark-cli` and `codex` are external executables supplied by the deployer.

## Maintainer confirmation required before public release

- Confirm that every contributor or employer who may own the original work permits publication under MIT.
- Confirm that the intended repository owner and package name are available.
- Review the current Codex, OpenAI, Feishu, and `lark-cli` terms for the planned distribution and hosted-bot model.
- Run a history-aware secret scanner after commits exist. The current checks only cover the current tree because this repository was initialized from a working directory without prior Git history.
- Decide where private vulnerability reports should be sent and update `SECURITY.md` with that concrete channel.

This is an engineering release assessment, not a legal opinion.

