# MemU through NAAvOS

MemU semantic retrieval is opt-in. SQLite remains authoritative for identity,
consent and approved notes. Only approved notes are projected. There is no
automatic session capture, scheduler installation or telemetry. The setup
window is optional when the intended host has loaded the local MCP tools.

## Agent workflow

Use `avatar_profile_save` to create/edit the profile, `avatar_get` before work,
and `avatar_remember`, `avatar_memory_search`, `avatar_memory_delete` for notes.
Profile changes back up first. Mutations require explicit approval and
`confirm=true`. Local configuration does not certify an actual ChatGPT session.

Call `avatar_memu_install` with `confirm=true` and a Python 3.11+ executable.
It installs the pinned optional SDK in `~/.naavos/memu-python` and returns its
Python path. This installs dependencies only and shares no memory.

Call `avatar_memu_configure` with `confirm=true` and a config such as:

```json
{
  "mode": "local",
  "python": "/absolute/path/returned/by/the/install/tool/bin/python",
  "provider": "jina",
  "api_key_env": "JINA_API_KEY",
  "allow_network": true
}
```

Supply the key through the host environment or its credential manager. Never
put credentials in prompts, tool arguments or this repository. The variable
must be available to the MCP process, not only the configuring terminal.

Local mode stores the index in `~/.naavos/memu-index.sqlite`, but sends approved
notes and queries to the chosen embedding provider. Explicit network consent
is required. The canonical ledger stays `~/.naavos/avatar.sqlite`.
Providers: `openai`, `jina`, `voyage`, `doubao`, `openrouter`; optional `model`
and `base_url` select the embedding deployment. HTTP is loopback-only.

MemU Cloud requires privacy mode `local_and_sync`, then config `mode: "cloud"`,
`api_key_env: "MEMU_CLOUD_API_KEY"`, the Python path and `allow_network: true`.
It uses the SDK's official endpoint and an Avatar-ID scope. This projects notes
only. It is not a complete identity/config backup or automatic new-device
restore system. Live Cloud and named ChatGPT acceptance need real credentials.

## CLI alternative

```sh
node bin/radoss.mjs setup run --provider local
node bin/radoss.mjs setup memory memu install --python python3 --confirm
node bin/radoss.mjs setup memory memu configure --mode local --python /absolute/path/to/memu-python/bin/python --provider jina --api-key-env JINA_API_KEY --allow-network --confirm
node bin/radoss.mjs setup memory search "How do I travel to work?"
node bin/radoss.mjs setup memory memu sync --confirm
node bin/radoss.mjs setup memory memu disable --confirm
```

## Failure and deletion

- SQLite saves remain durable during an outage. Projection is reported pending;
  search returns an explicit degraded FTS fallback instead of stale MemU data.
- Sync replaces the Avatar-scoped recall file and removes obsolete content and
  segments. Deletion during an outage remains pending upstream and is reported.
  Historical backups may retain copies; this is not a forensic disk wipe.
- Hits resolve only to the current owner's active, approved SQLite notes.
- Pause blocks backend calls and discards responses arriving after pause.
- Disable stops MemU calls but retains its projection. Re-enable/sync to retry
  outstanding projection work. Config changes have encrypted local backups.
- A lost/replaced local ledger cannot silently overwrite a configured Cloud
  projection. Restore the ledger and setup/config backup before syncing.
- Local MemU still needs device backups. Cloud note projection is not proof of
  full backup/restore, signed installation or actual ChatGPT account access.

## Verification

Install `scripts/requirements-memu.txt`, set `NAAVOS_MEMU_TEST_PYTHON` to that
Python executable, then run `npm test`. Tests exercise the real pinned MemU SDK,
SQLite and MCP with deterministic loopback embeddings: synonym recall,
deletion, pause, scope and outage fallback. This is wiring evidence, not a
production-model quality or speed benchmark. CI also exercises the browser UI
with MemU enabled and the native packaged MCP on macOS and Windows.
