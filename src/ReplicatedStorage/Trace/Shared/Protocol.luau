local Protocol = {
	RemoteName = "TraceClientLog",
	MaxMessageLength = 4_000,
	MaxStackLength = 16_000,
	MaxSourceScriptLength = 512,
	MaxRepeatCount = 10_000,
	ClientFlushIntervalSeconds = 5,
	MaxPendingClientGroups = 100,
	ClientRateWindowSeconds = 10,
	ClientRateLimit = 30,
}

return table.freeze(Protocol)
