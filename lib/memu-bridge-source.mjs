// Embedded in Node SEA builds as well as source installations. No shell or secrets in argv.
export const MEMU_BRIDGE_SOURCE = String.raw`
import asyncio, importlib.metadata, json, os, sys
from pathlib import Path

async def main():
    request = json.load(sys.stdin)
    version = importlib.metadata.version("memu-cli")
    if version != "0.11.0b3":
        raise RuntimeError("unsupported_version")
    cfg = request["config"]
    key = os.environ.get(cfg["api_key_env"], "")
    if not key:
        raise RuntimeError("missing_credential")
    if request["operation"] == "probe":
        return {"version": version, "status": "dependency_ready"}
    if cfg["mode"] == "cloud":
        import httpx
        from memu.cloud import CloudMemoryClient
        service = CloudMemoryClient(api_key=key, timeout=httpx.Timeout(12), max_attempts=1)
    else:
        from memu.app import MemoryService
        store = Path(request["index_path"])
        store.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.umask(0o077)
        profile = {"provider": cfg["provider"], "client_backend": "httpx", "api_key": key}
        if cfg.get("model"): profile["embed_model"] = cfg["model"]
        if cfg.get("base_url"): profile["base_url"] = cfg["base_url"]
        service = MemoryService(
            database_config={"metadata_store": {"provider": "sqlite", "dsn": "sqlite:///" + str(store)}},
            embedding_profiles={"default": profile},
            progressive_retrieve_config={"file": {"top_k": 20, "tracks": ["memory"]}, "resource": {"enabled": False}},
        )
    scope = {"user_id": request["avatar_id"], "agent_id": "naavos-approved"}
    # A single scoped recall file is replaced in full: deleting a note also removes
    # its content and old embedding segments, rather than leaving a stale projection.
    text_to_id = {}
    for note in request["notes"]:
        text = "[NAAVOS:" + note["id"] + "] " + " ".join(note["content"].splitlines())
        text_to_id[text] = note["id"]
    await service.commit_results(user=scope, recall_files=[{
        "name": "naavos-approved-memories", "track": "memory",
        "description": "Explicitly approved NAAvOS notes", "content": "\n".join(text_to_id),
    }])
    hits = []
    if request["operation"] == "retrieve" and text_to_id:
        result = await service.progressive_retrieve(request["query"], where=scope)
        for segment in result.get("segments", []):
            note_id = text_to_id.get(segment.get("text", ""))
            # SDK serialization omits scope columns. Retrieval is scoped above;
            # the exact-text map additionally permits only current local note IDs.
            if note_id:
                hits.append({"id": note_id, "score": segment.get("score", 0)})
    if cfg["mode"] == "local":
        os.chmod(request["index_path"], 0o600)
    return {"status": "ready", "indexed": len(request["notes"]), "hits": hits, "version": version}

try:
    print(json.dumps(asyncio.run(main())))
except Exception as error:
    # Provider exceptions can contain credentials or private request/response bodies.
    name = str(error) if str(error) in ("unsupported_version", "missing_credential") else type(error).__name__
    print(json.dumps({"error": name}))
    sys.exit(1)
`;
