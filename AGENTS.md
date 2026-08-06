# Agent Rules

## Production Availability (Absolute Rule)

- Never run `systemctl stop`, `systemctl restart`, `service restart`, `kill`, `pkill`, stop a production job, reboot a VM, or perform any equivalent traffic- or job-interrupting action as a routine deploy or validation step.
- Any production stop, restart, reload, process replacement, or expected client-visible interruption requires Martin's explicit approval in the current task after stating the affected service, the impact, and the expected duration. General execution autonomy does not authorize downtime.
- The only exception is an outage already in progress when Martin explicitly asks to restore or relaunch the affected service.
- Deployments and migrations must keep the healthy runtime active. If a candidate, migration, or canary fails, abort it without touching the active runtime.
- If zero-downtime cannot be guaranteed, stop before the production mutation and ask Martin.
