"""PR Studio: the agent half is empty; all work happens in dashboard/plugin_api.py and desktop/plugin.js."""


def register(ctx):  # noqa: ARG001 - no tools or hooks; the backend mounts via dashboard/manifest.json
    return None
