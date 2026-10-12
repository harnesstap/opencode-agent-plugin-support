# Vendored: Agent Plugins JSON Schemas

`schemas/` is copied unmodified from
[agentplugins/agent-plugins-spec](https://github.com/agentplugins/agent-plugins-spec) at commit
`ff8ab5e392cc87bd88d87c060815a87490e51003`. Schemas are Apache-2.0 (see `LICENSE.md`, `LICENSES/`).

The tests use them to cross-check this package's hand-written validators against the official
machine-readable schemas. Only 1.0.0 is supported by this package; 1.1.0 (a working draft whose
schemas differ from 1.0.0 only in their `$id` and `$schema` constants) is kept to test that it is rejected.
