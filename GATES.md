# Linkstash clean-machine release gates

These gates are the acceptance checklist for rebuilding this repository on a
clean Linux machine.

| Gate | Evidence | Status |
| --- | --- | --- |
| Git repository with commits | `git log --oneline` | pending commit |
| Dependency lockfile | `package-lock.json` + `npm ci` | present; runtime check pending |
| Runtime pinned | `.nvmrc`, `.node-version`, `package.json#engines`, Dockerfile | present |
| Docker build/run definition | `Dockerfile`, `.dockerignore` | present; Docker unavailable on this host |
| One test command | `npm test` | existing command |
| Setup/run/test documentation | `README.md` | present |
| Environment template without secrets | `.env.example` | present |
| No machine-specific absolute paths | repository text audit | pending |

Required commands are documented in `README.md`. The current Windows host has
Node 25 and does not have Docker installed, so the exact pinned Node 22 Docker
build must be verified on Linux or a host with Docker before release.
