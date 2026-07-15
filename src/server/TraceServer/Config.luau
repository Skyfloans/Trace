local RunService = game:GetService("RunService")

local Config = {
	Endpoint = "https://trace-production-c9d4.up.railway.app",

	IngestionSecretName = "TraceKey",

	DevelopmentIngestionKey = nil :: string?,

	FlushIntervalSeconds = 5,
	HeartbeatIntervalSeconds = 60,
	MaxEventsPerBatch = 100,
	MaxRepeatCount = 10_000,
	MaxBatchUncompressedBytes = 256_000,
	MaxSessionsPerBatch = 100,
	MaxQueuedEvents = 1_000,
	CaptureOutputMessages = false,
}

if RunService:IsStudio() then
	local localConfigModule = script.Parent:FindFirstChild("LocalConfig")
	if localConfigModule and localConfigModule:IsA("ModuleScript") then
		local localConfig = require(localConfigModule)
		Config.Endpoint = localConfig.Endpoint or Config.Endpoint
		Config.DevelopmentIngestionKey = localConfig.DevelopmentIngestionKey
	end
end

return table.freeze(Config)
