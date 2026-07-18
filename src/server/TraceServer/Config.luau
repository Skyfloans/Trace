local RunService = game:GetService("RunService")

local Config = {
	Endpoint = "https://api.tracestack.gg",

	IngestionSecretName = "TraceKey",

	DevelopmentIngestionKey = nil :: string?,

	-- Lifecycle updates are delivered promptly, while identical errors remain
	-- in a longer in-memory bucket before one compact occurrence is uploaded.
	FlushIntervalSeconds = 5,
	EventAggregationWindowSeconds = 60,
	HeartbeatIntervalSeconds = 300,
	MaxEventsPerBatch = 100,
	MaxRepeatCount = 10_000,
	MaxBatchUncompressedBytes = 256_000,
	MaxSessionsPerBatch = 100,
	MaxQueuedEvents = 1_000,
	MaxSampledStackKeys = 5_000,
	CaptureOutputMessages = false,

	-- Known non-actionable messages are discarded before batching or upload.
	-- Keep these prefixes specific so genuine warnings are never hidden.
	IgnoredMessagePrefixes = {
		"Data loaded for player ",
	},
}

if RunService:IsStudio() then
	local localConfigModule = script.Parent:FindFirstChild("LocalConfig")
	if localConfigModule and localConfigModule:IsA("ModuleScript") then
		local localConfig = require(localConfigModule)
		Config.Endpoint = localConfig.Endpoint or Config.Endpoint
		Config.DevelopmentIngestionKey = localConfig.DevelopmentIngestionKey
		Config.FlushIntervalSeconds = localConfig.FlushIntervalSeconds or Config.FlushIntervalSeconds
		Config.EventAggregationWindowSeconds = localConfig.EventAggregationWindowSeconds
			or Config.EventAggregationWindowSeconds
		Config.HeartbeatIntervalSeconds = localConfig.HeartbeatIntervalSeconds or Config.HeartbeatIntervalSeconds
		Config.IgnoredMessagePrefixes = localConfig.IgnoredMessagePrefixes or Config.IgnoredMessagePrefixes
	end
end

return table.freeze(Config)
