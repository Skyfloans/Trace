local RunService = game:GetService("RunService")

local Config = {
	-- Replace this with the deployed Trace API URL before publishing.
	Endpoint = "http://127.0.0.1:3000",

	-- Create this secret in Experience Settings > Security > Secrets.
	IngestionSecretName = "TRACE_INGEST_KEY",

	-- Local play tests cannot always access experience secrets. Leave this nil
	-- in committed code; set it temporarily only in a local, uncommitted copy.
	DevelopmentIngestionKey = nil :: string?,

	FlushIntervalSeconds = 5,
	HeartbeatIntervalSeconds = 60,
	MaxEventsPerBatch = 100,
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
